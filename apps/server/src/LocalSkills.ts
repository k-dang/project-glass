import { AgentError, type AgentEngine, LOCAL_SKILLS_NAMESPACE, Skill } from "@glass/contracts"
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

/** The folders each Agent program reads Local skills from, in the order it reads them. */
const foldersOf = (home: string): Record<AgentEngine, ReadonlyArray<string>> => ({
  "claude-code": [join(home, ".claude", "skills")],
  pi: [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")],
})

interface FoundFile {
  /** Relative to the folder the program reads, with `/` between segments. */
  readonly path: string
  readonly executable: boolean
}

interface FoundSkill {
  readonly folder: string
  readonly directory: string
  readonly files: ReadonlyArray<FoundFile>
}

const READS = { concurrency: 8 } as const

const couldNotRead = new AgentError({
  message: "Glass couldn't read your Local skills. Try again.",
})

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
    readonly names: (engine: AgentEngine) => Effect.Effect<ReadonlyArray<string>, AgentError>
    /** The Local skills the program reads, as they are now, to send a Sandbox Agent. */
    readonly source: (engine: AgentEngine) => Effect.Effect<SkillSource, AgentError>
  }
>()("@glass/server/LocalSkills") {
  static readonly layer = Layer.effect(
    LocalSkills,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const folders = foldersOf((yield* ServerConfig).homeDirectory)

      /** Every file under `folder`, following each symlink once and skipping broken ones. */
      const filesUnder = (
        folder: string,
        relative: string,
        visited: Set<string>,
      ): Effect.Effect<ReadonlyArray<FoundFile>, PlatformError.PlatformError> =>
        Effect.gen(function* () {
          const real = yield* fs.realPath(join(folder, relative))

          if (visited.has(real)) return []
          visited.add(real)

          const entries = yield* fs.readDirectory(join(folder, relative))

          const nested = yield* Effect.forEach(
            entries.toSorted(),
            (entry) =>
              Effect.gen(function* () {
                const path = relative === "" ? entry : `${relative}/${entry}`

                const info = yield* fs.stat(join(folder, path)).pipe(
                  Effect.map(Option.some),
                  Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
                )

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

      const found = (engine: AgentEngine) =>
        Effect.forEach(folders[engine], (folder) =>
          filesUnder(folder, "", new Set()).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
            Effect.map((files) =>
              [...filesBySkill(files)].flatMap(([directory, owned]): ReadonlyArray<FoundSkill> =>
                directory === "" ? [] : [{ folder, directory, files: owned }],
              ),
            ),
          ),
        ).pipe(Effect.map((perFolder) => perFolder.flat()))

      return LocalSkills.of({
        names: (engine) =>
          found(engine).pipe(
            Effect.flatMap((skills) =>
              Effect.forEach(
                skills,
                ({ folder, directory }) =>
                  fs.readFileString(join(folder, skillFilePath(directory))).pipe(
                    Effect.map((text) => {
                      const read = readSkill(directory, text, lastSegment(directory))

                      return read instanceof Skill ? read.name : lastSegment(directory)
                    }),
                  ),
                READS,
              ),
            ),
            Effect.map((names) => [...new Set(names)].toSorted()),
            reading,
            Effect.withSpan("LocalSkills.names"),
          ),
        source: (engine) =>
          found(engine).pipe(
            Effect.flatMap((skills) => {
              const taken = new Set<string>()

              return Effect.forEach(skills, ({ folder, directory, files }) =>
                Effect.forEach(
                  files,
                  ({ path, executable }) =>
                    fs.readFile(join(folder, path)).pipe(
                      Effect.map((contents) => ({
                        path: path.slice(directory.length + 1),
                        executable,
                        contents,
                      })),
                    ),
                  READS,
                ).pipe(
                  Effect.map((sent): SentSkill => ({
                    name: uniqueFolder(taken, lastSegment(directory)),
                    files: sent,
                  })),
                ),
              )
            }),
            Effect.map((skills) => ({ name: LOCAL_SKILLS_NAMESPACE, skills })),
            reading,
            Effect.withSpan("LocalSkills.source"),
          ),
      })
    }),
  )
}
