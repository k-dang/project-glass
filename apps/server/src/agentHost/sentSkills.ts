import { Effect, FileSystem, type Scope } from "effect"
import { randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, relative } from "node:path"
import { HostAgentError, type SkillSource } from "./protocol"

export interface WrittenSkills {
  readonly plugin: string
  readonly skills: ReadonlyArray<string>
}

const couldNotWrite = new HostAgentError({
  message: "Glass couldn't write the Agent's skills. Try again.",
})

const isInside = (folder: string, target: string) => {
  const path = relative(folder, target)

  return path !== "" && !path.startsWith("..") && !isAbsolute(path)
}

export const scopedFolder = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    yield* Effect.acquireRelease(fs.makeDirectory(folder, { recursive: true }), () =>
      fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore),
    )

    return folder
  })

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

    return yield* Effect.forEach(sources, ({ name, files }) =>
      Effect.gen(function* () {
        const plugin = join(directory, name)
        const skillsFolder = join(plugin, "skills")

        if (!isInside(directory, plugin)) return yield* couldNotWrite

        yield* fs.makeDirectory(join(plugin, ".claude-plugin"), { recursive: true })
        yield* fs.writeFileString(
          join(plugin, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name }),
        )

        const skills = new Set<string>()

        for (const { path, executable, contents } of files) {
          const target = join(skillsFolder, path)

          if (!isInside(skillsFolder, target) || dirname(target) === skillsFolder)
            return yield* couldNotWrite

          skills.add(join(skillsFolder, path.split("/")[0]!))
          yield* fs.makeDirectory(dirname(target), { recursive: true })
          yield* fs.writeFile(target, contents)

          if (executable) yield* fs.chmod(target, 0o755)
        }

        return { plugin, skills: [...skills] }
      }),
    )
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.logWarning("Couldn't write an Agent's skills", cause).pipe(
        Effect.andThen(Effect.fail(couldNotWrite)),
      ),
    ),
  )
