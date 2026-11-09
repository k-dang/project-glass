import { AgentError, type AgentEngine, LOCAL_SKILLS_NAMESPACE, Skill } from "@glass/contracts"
import { Context, Effect, FileSystem, Layer, type PlatformError } from "effect"
import { join } from "node:path"
import type { SentSkill, SkillFile, SkillSource } from "./agentHost/protocol"
import { ServerConfig } from "./ServerConfig"
import { readSkill, uniqueFolder } from "./skillPackContents"

const SKILL_FILE = "SKILL.md"

/** The folders each Agent program reads Local skills from, in the order it reads them. */
const foldersOf = (home: string): Record<AgentEngine, ReadonlyArray<string>> => ({
  "claude-code": [join(home, ".claude", "skills")],
  pi: [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")],
})

interface FoundSkill {
  readonly folder: string
  readonly name: string
  readonly files: ReadonlyArray<SkillFile>
}

const couldNotRead = new AgentError({
  message: "Glass couldn't read your Local skills. Try again.",
})

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

      const filesUnder = (
        folder: string,
        relative: string,
        visited: Set<string>,
      ): Effect.Effect<ReadonlyArray<SkillFile>, PlatformError.PlatformError> =>
        Effect.gen(function* () {
          const directory = join(folder, relative)
          const real = yield* fs.realPath(directory)

          if (visited.has(real)) return []
          visited.add(real)

          const entries = (yield* fs.readDirectory(directory)).toSorted()

          const nested = yield* Effect.forEach(entries, (entry) =>
            Effect.gen(function* () {
              const path = relative === "" ? entry : `${relative}/${entry}`
              const info = yield* fs.stat(join(folder, path))

              if (info.type === "Directory") return yield* filesUnder(folder, path, visited)

              if (info.type !== "File") return []

              return [
                {
                  path,
                  executable: (info.mode & 0o111) !== 0,
                  contents: yield* fs.readFile(join(folder, path)),
                },
              ]
            }),
          )

          return nested.flat()
        })

      const skillsUnder = (
        directory: string,
        visited: Set<string>,
      ): Effect.Effect<ReadonlyArray<FoundSkill>, PlatformError.PlatformError> =>
        Effect.gen(function* () {
          const real = yield* fs.realPath(directory)

          if (visited.has(real)) return []
          visited.add(real)

          const entries = (yield* fs.readDirectory(directory)).toSorted()

          const nested = yield* Effect.forEach(entries, (entry) =>
            Effect.gen(function* () {
              const folder = join(directory, entry)

              if ((yield* fs.stat(folder)).type !== "Directory") return []

              if (!(yield* fs.exists(join(folder, SKILL_FILE)))) {
                return yield* skillsUnder(folder, visited)
              }

              const text = yield* fs.readFileString(join(folder, SKILL_FILE))
              const read = readSkill(entry, text, entry)

              return [
                {
                  folder: entry,
                  name: read instanceof Skill ? read.name : entry,
                  files: yield* filesUnder(folder, "", new Set()),
                },
              ]
            }),
          )

          return nested.flat()
        })

      const found = (engine: AgentEngine) =>
        Effect.forEach(folders[engine], (folder) =>
          skillsUnder(folder, new Set()).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
          ),
        ).pipe(
          Effect.map((perFolder) => perFolder.flat()),
          Effect.catchTag("PlatformError", (cause) =>
            Effect.logWarning("Couldn't read the Local skills", cause).pipe(
              Effect.andThen(Effect.fail(couldNotRead)),
            ),
          ),
        )

      return LocalSkills.of({
        names: (engine) =>
          found(engine).pipe(
            Effect.map((skills) => [...new Set(skills.map(({ name }) => name))].toSorted()),
            Effect.withSpan("LocalSkills.names"),
          ),
        source: (engine) =>
          found(engine).pipe(
            Effect.map((skills) => {
              const taken = new Set<string>()

              return {
                name: LOCAL_SKILLS_NAMESPACE,
                skills: skills.map(({ folder, files }): SentSkill => ({
                  name: uniqueFolder(taken, folder),
                  files,
                })),
              }
            }),
            Effect.withSpan("LocalSkills.source"),
          ),
      })
    }),
  )
}
