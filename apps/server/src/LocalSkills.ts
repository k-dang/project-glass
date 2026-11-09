import { type AgentEngine, LOCAL_SKILLS_NAMESPACE, LocalSkillsError, Skill } from "@glass/contracts"
import { Context, Effect, FileSystem, Layer, Option, type PlatformError } from "effect"
import { join } from "node:path"
import type { SentSkill, SkillSource } from "./agentHost/protocol"
import { ServerConfig } from "./ServerConfig"
import {
  filesBySkill,
  lastSegment,
  readSkill,
  skillFilePath,
  uniqueFolder,
} from "./skillPackContents"

interface SkillFolders {
  /** The folders the program reads Local skills from, in the order it reads them. */
  readonly folders: ReadonlyArray<string>
  /** Whether the program finds skills below a folder's top level, as pi does and Claude Code doesn't. */
  readonly nested: boolean
}

const foldersOf = (home: string): Record<AgentEngine, SkillFolders> => ({
  "claude-code": { folders: [join(home, ".claude", "skills")], nested: false },
  pi: {
    folders: [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")],
    nested: true,
  },
})

interface FoundFile {
  /** Relative to the folder the program reads, with `/` between segments. */
  readonly path: string
  readonly executable: boolean
}

interface FoundSkill {
  readonly folder: string
  readonly directory: string
  readonly skill: Skill
  readonly files: ReadonlyArray<FoundFile>
}

const READS = { concurrency: 8 } as const

const couldNotRead = new LocalSkillsError({
  message: "Glass couldn't read your Local skills. Try again.",
})

/**
 * What a program does with a file or folder it can't read: goes without it. A broken symlink is
 * common in dotfiles and goes quietly; one Glass isn't allowed to read is worth a log line.
 */
const orSkipped = <A>(
  effect: Effect.Effect<A, PlatformError.PlatformError>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchReasons("PlatformError", {
      NotFound: () => Effect.succeedNone,
      PermissionDenied: (reason) =>
        Effect.logWarning("Skipped a Local skills file Glass can't read", reason).pipe(
          Effect.as(Option.none()),
        ),
    }),
  )

const reading = <A>(effect: Effect.Effect<A, PlatformError.PlatformError>) =>
  effect.pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.logWarning("Couldn't read the Local skills", cause).pipe(
        Effect.andThen(Effect.fail(couldNotRead)),
      ),
    ),
  )

export class LocalSkills extends Context.Service<
  LocalSkills,
  {
    /** The names of the Local skills the program reads, for the new-Agent picker. */
    readonly names: (engine: AgentEngine) => Effect.Effect<ReadonlyArray<string>, LocalSkillsError>
    /**
     * The Local skills the program reads, as they are now, to send a Sandbox Agent: one source, or
     * none when there are no skills.
     */
    readonly sources: (
      engine: AgentEngine,
    ) => Effect.Effect<ReadonlyArray<SkillSource>, LocalSkillsError>
  }
>()("@glass/server/LocalSkills") {
  static readonly layer = Layer.effect(
    LocalSkills,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const skillFolders = foldersOf((yield* ServerConfig).homeDirectory)

      /** Every file under `folder` Glass can read, following each symlink once. */
      const filesUnder = (
        folder: string,
        relative: string,
        visited: Set<string>,
      ): Effect.Effect<ReadonlyArray<FoundFile>, PlatformError.PlatformError> =>
        Effect.gen(function* () {
          const real = yield* orSkipped(fs.realPath(join(folder, relative)))

          if (Option.isNone(real) || visited.has(real.value)) return []
          visited.add(real.value)

          const entries = yield* orSkipped(fs.readDirectory(join(folder, relative)))

          if (Option.isNone(entries)) return []

          const nested = yield* Effect.forEach(
            entries.value.toSorted(),
            (entry) =>
              Effect.gen(function* () {
                const path = relative === "" ? entry : `${relative}/${entry}`
                const info = yield* orSkipped(fs.stat(join(folder, path)))

                if (Option.isNone(info)) return []

                if (info.value.type === "Directory") return yield* filesUnder(folder, path, visited)

                return info.value.type === "File"
                  ? [{ path, executable: (info.value.mode & 0o111) !== 0 }]
                  : []
              }),
            READS,
          )

          return nested.flat()
        })

      /** The skills that load, as the programs load them: skipping any whose SKILL.md doesn't. */
      const found = (engine: AgentEngine) => {
        const { folders, nested } = skillFolders[engine]

        const loads = (directory: string) =>
          directory !== "" && (nested || !directory.includes("/"))

        return Effect.forEach(folders, (folder) =>
          filesUnder(folder, "", new Set()).pipe(
            Effect.flatMap((files) =>
              Effect.forEach(
                [...filesBySkill(files)].filter(([directory]) => loads(directory)),
                ([directory, owned]) =>
                  orSkipped(fs.readFileString(join(folder, skillFilePath(directory)))).pipe(
                    Effect.map(
                      Option.flatMap((text) => {
                        const skill = readSkill(directory, text, lastSegment(directory))

                        return skill instanceof Skill
                          ? Option.some<FoundSkill>({ folder, directory, skill, files: owned })
                          : Option.none()
                      }),
                    ),
                  ),
                READS,
              ),
            ),
          ),
        ).pipe(Effect.map((perFolder) => perFolder.flat().flatMap(Option.toArray)))
      }

      const sent = (taken: Set<string>, { folder, directory, files }: FoundSkill) =>
        Effect.forEach(
          files,
          ({ path, executable }) =>
            orSkipped(fs.readFile(join(folder, path))).pipe(
              Effect.map(
                Option.map((contents) => ({
                  path: path.slice(directory.length + 1),
                  executable,
                  contents,
                })),
              ),
            ),
          READS,
        ).pipe(
          Effect.map((read): SentSkill => ({
            name: uniqueFolder(taken, lastSegment(directory)),
            files: read.flatMap(Option.toArray),
          })),
        )

      return LocalSkills.of({
        names: (engine) =>
          found(engine).pipe(
            Effect.map((skills) => [...new Set(skills.map(({ skill }) => skill.name))].toSorted()),
            reading,
            Effect.withSpan("LocalSkills.names"),
          ),
        sources: (engine) =>
          found(engine).pipe(
            Effect.flatMap((skills) => {
              const taken = new Set<string>()

              return Effect.forEach(skills, (skill) => sent(taken, skill))
            }),
            Effect.map((skills) =>
              skills.length === 0 ? [] : [{ name: LOCAL_SKILLS_NAMESPACE, skills }],
            ),
            reading,
            Effect.withSpan("LocalSkills.sources"),
          ),
      })
    }),
  )
}
