import { type AgentEngine, LOCAL_SKILLS_NAMESPACE, LocalSkillsError, Skill } from "@glass/contracts"
import { Context, Effect, FileSystem, Layer, Option, type PlatformError, Predicate } from "effect"
import { join } from "node:path"
import type { SentSkill, SkillSource } from "./agentHost/protocol"
import { ServerConfig } from "./ServerConfig"
import {
  filesBySkill,
  lastSegment,
  readSkill,
  skillFilePath,
  claimFolder,
} from "./skillPackContents"

interface SkillFolders {
  readonly folders: ReadonlyArray<string>
  readonly readsNestedSkills: boolean
}

const foldersOf = (home: string): Record<AgentEngine, SkillFolders> => ({
  "claude-code": { folders: [join(home, ".claude", "skills")], readsNestedSkills: false },
  opencode: {
    folders: [
      join(home, ".config", "opencode", "skills"),
      join(home, ".config", "opencode", "skill"),
      join(home, ".claude", "skills"),
      join(home, ".agents", "skills"),
    ],
    readsNestedSkills: true,
  },
  pi: {
    folders: [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")],
    readsNestedSkills: true,
  },
})

interface FoundFile {
  readonly path: string
  readonly executable: boolean
}

interface FoundSkill {
  readonly folder: string
  readonly directory: string
  readonly realSkillFile: string
  readonly skill: Skill
  readonly files: ReadonlyArray<FoundFile>
}

const READS = { concurrency: 8 } as const

const couldNotRead = new LocalSkillsError({
  message: "Glass couldn't read your Local skills. Try again.",
})

const orSkipped = <A>(
  effect: Effect.Effect<A, PlatformError.PlatformError>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchReasons("PlatformError", {
      NotFound: () => Effect.succeedNone,
      BadResource: (reason, error) =>
        Predicate.hasProperty(reason.cause, "code") && reason.cause.code === "ELOOP"
          ? Effect.succeedNone
          : Effect.fail(error),
      PermissionDenied: (reason) =>
        Effect.logWarning("Skipped a Local skills file Glass can't read", reason).pipe(
          Effect.as(Option.none()),
        ),
    }),
  )

/**
 * pi loads a SKILL.md once however many paths reach it, and keeps the first skill of a name, so
 * the later ones are never sent.
 */
const firstOfEach = (skills: ReadonlyArray<FoundSkill>) => {
  const names = new Set<string>()
  const files = new Set<string>()

  return skills.filter(({ skill, realSkillFile }) => {
    if (names.has(skill.name) || files.has(realSkillFile)) return false

    names.add(skill.name)
    files.add(realSkillFile)

    return true
  })
}

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
    readonly names: (engine: AgentEngine) => Effect.Effect<ReadonlyArray<string>, LocalSkillsError>
    readonly source: (
      engine: AgentEngine,
    ) => Effect.Effect<Option.Option<SkillSource>, LocalSkillsError>
  }
>()("@glass/server/LocalSkills") {
  static readonly layer = Layer.effect(
    LocalSkills,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const skillFolders = foldersOf((yield* ServerConfig).homeDirectory)

      const filesUnder = (
        folder: string,
        relative: string,
        ancestors: ReadonlySet<string>,
      ): Effect.Effect<ReadonlyArray<FoundFile>, PlatformError.PlatformError> =>
        Effect.gen(function* () {
          const real = yield* orSkipped(fs.realPath(join(folder, relative)))

          if (Option.isNone(real) || ancestors.has(real.value)) return []

          const entries = yield* orSkipped(fs.readDirectory(join(folder, relative)))

          if (Option.isNone(entries)) return []

          const nested = yield* Effect.forEach(
            entries.value.toSorted(),
            (entry) =>
              Effect.gen(function* () {
                const path = relative === "" ? entry : `${relative}/${entry}`
                const info = yield* orSkipped(fs.stat(join(folder, path)))

                if (Option.isNone(info)) return []

                if (info.value.type === "Directory")
                  return yield* filesUnder(folder, path, new Set([...ancestors, real.value]))

                return info.value.type === "File"
                  ? [{ path, executable: (info.value.mode & 0o111) !== 0 }]
                  : []
              }),
            READS,
          )

          return nested.flat()
        })

      const found = (engine: AgentEngine) => {
        const { folders, readsNestedSkills } = skillFolders[engine]

        const loads = (directory: string) =>
          directory !== "" && (readsNestedSkills || !directory.includes("/"))

        return Effect.forEach(folders, (folder) =>
          filesUnder(folder, "", new Set()).pipe(
            Effect.flatMap((files) =>
              Effect.forEach(
                [...filesBySkill(files)].filter(([directory]) => loads(directory)),
                ([directory, owned]) =>
                  Effect.gen(function* () {
                    const skillFile = join(folder, skillFilePath(directory))

                    const read = yield* orSkipped(
                      Effect.all([fs.readFileString(skillFile), fs.realPath(skillFile)]),
                    )

                    if (Option.isNone(read)) return []

                    const [text, realSkillFile] = read.value
                    const skill = readSkill(directory, text)

                    return skill instanceof Skill
                      ? [{ folder, directory, realSkillFile, skill, files: owned }]
                      : []
                  }),
                READS,
              ),
            ),
          ),
        ).pipe(Effect.map((perFolder) => firstOfEach(perFolder.flat(2))))
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
            name: claimFolder(taken, lastSegment(directory)),
            files: read.flatMap(Option.toArray),
          })),
        )

      return LocalSkills.of({
        names: (engine) =>
          found(engine).pipe(
            Effect.map((skills) => skills.map(({ skill }) => skill.name).toSorted()),
            reading,
            Effect.withSpan("LocalSkills.names"),
          ),
        source: (engine) =>
          found(engine).pipe(
            Effect.flatMap((skills) => {
              const taken = new Set<string>()

              return Effect.forEach(skills, (skill) => sent(taken, skill))
            }),
            Effect.map((skills) =>
              skills.length === 0
                ? Option.none()
                : Option.some({ name: LOCAL_SKILLS_NAMESPACE, skills }),
            ),
            reading,
            Effect.withSpan("LocalSkills.source"),
          ),
      })
    }),
  )
}
