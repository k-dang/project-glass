import { Effect, FileSystem, type Scope } from "effect"
import { randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, relative } from "node:path"
import { HostAgentError, type SkillSource } from "./protocol"
import { scopedFolder } from "./scopedFolder"

export interface WrittenSkills {
  readonly plugin: string
  readonly skills: ReadonlyArray<string>
}

const couldNotWrite = new HostAgentError({
  message: "Glass couldn't write the Agent's skills. Try again.",
})

const inside = (folder: string, path: string) => {
  const target = join(folder, path)
  const relation = relative(folder, target)

  return relation === "" || relation.startsWith("..") || isAbsolute(relation)
    ? Effect.fail(couldNotWrite)
    : Effect.succeed(target)
}

export const writeSentSkills = (
  folder: string,
  sources: ReadonlyArray<SkillSource>,
): Effect.Effect<
  ReadonlyArray<WrittenSkills>,
  HostAgentError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    if (sources.length === 0) return []

    const fs = yield* FileSystem.FileSystem
    const directory = yield* scopedFolder(`${folder}.skills-${randomUUID()}`)

    return yield* Effect.forEach(sources, ({ name, skills }) =>
      Effect.gen(function* () {
        const plugin = yield* inside(directory, name)

        yield* fs.makeDirectory(join(plugin, ".claude-plugin"), { recursive: true })
        yield* fs.writeFileString(
          join(plugin, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name }),
        )

        const written = yield* Effect.forEach(skills, (skill) =>
          Effect.gen(function* () {
            const skillFolder = yield* inside(join(plugin, "skills"), skill.name)

            for (const { path, executable, contents } of skill.files) {
              const target = yield* inside(skillFolder, path)

              yield* fs.makeDirectory(dirname(target), { recursive: true })
              yield* fs.writeFile(target, contents)

              if (executable) yield* fs.chmod(target, 0o755)
            }

            return skillFolder
          }),
        )

        return { plugin, skills: written }
      }),
    )
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.logWarning("Couldn't write an Agent's skills", cause).pipe(
        Effect.andThen(Effect.fail(couldNotWrite)),
      ),
    ),
  )
