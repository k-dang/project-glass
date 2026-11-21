import { Effect, FileSystem, type Scope } from "effect"
import { randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, relative } from "node:path"
import { HostThreadError, type SkillSource } from "./protocol"
import { scopedFolder } from "./scopedFolder"

export interface WrittenSkills {
  readonly plugin: string
  readonly skills: ReadonlyArray<string>
}

const WRITES_AT_ONCE = 8

const couldNotWrite = new HostThreadError({
  message: "Glass couldn't write the Thread's skills. Try again.",
})

const inside = (folder: string, path: string): Effect.Effect<string, HostThreadError> => {
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
  HostThreadError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    if (sources.length === 0) return []

    const fs = yield* FileSystem.FileSystem
    const directory = yield* scopedFolder(`${folder}.skills-${randomUUID()}`)

    const planned = yield* Effect.forEach(sources, ({ name, skills }) =>
      Effect.gen(function* () {
        const plugin = yield* inside(directory, name)

        const perSkill = yield* Effect.forEach(skills, (skill) =>
          Effect.gen(function* () {
            const skillFolder = yield* inside(join(plugin, "skills"), skill.name)

            const files = yield* Effect.forEach(skill.files, ({ path, executable, contents }) =>
              inside(skillFolder, path).pipe(
                Effect.map((target) => ({ target, contents, executable })),
              ),
            )

            return { skillFolder, files }
          }),
        )

        return {
          written: { plugin, skills: perSkill.map(({ skillFolder }) => skillFolder) },
          files: [
            {
              target: join(plugin, ".claude-plugin", "plugin.json"),
              contents: new TextEncoder().encode(JSON.stringify({ name })),
              executable: false,
            },
            ...perSkill.flatMap(({ files }) => files),
          ],
        }
      }),
    )

    yield* Effect.forEach(
      planned.flatMap(({ files }) => files),
      ({ target, contents, executable }) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(target), { recursive: true })
          yield* fs.writeFile(target, contents)

          if (executable) yield* fs.chmod(target, 0o755)
        }).pipe(Effect.uninterruptible),
      { concurrency: WRITES_AT_ONCE, discard: true },
    )

    return planned.map(({ written }) => written)
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.logWarning("Couldn't write a Thread's skills", cause).pipe(
        Effect.andThen(Effect.fail(couldNotWrite)),
      ),
    ),
  )
