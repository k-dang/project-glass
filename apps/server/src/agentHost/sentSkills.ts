import { Effect, FileSystem, type Scope, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, relative } from "node:path"
import { HostConversationError, type SkillSource } from "./protocol"
import { scopedFolder } from "./scopedFolder"

export interface WrittenSkills {
  readonly plugin: string
  readonly skills: ReadonlyArray<string>
}

const WRITES_AT_ONCE = 8

const TOGETHER = { concurrency: "unbounded" } as const

const couldNotWrite = new HostConversationError({
  message: "Glass couldn't write the Conversation's skills. Try again.",
})

const inside = (folder: string, path: string): Effect.Effect<string, HostConversationError> => {
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
  HostConversationError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    if (sources.length === 0) return []

    const fs = yield* FileSystem.FileSystem
    const writes = yield* Semaphore.make(WRITES_AT_ONCE)
    const directory = yield* scopedFolder(`${folder}.skills-${randomUUID()}`)

    const write = (target: string, contents: Uint8Array, executable: boolean) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(dirname(target), { recursive: true })
        yield* fs.writeFile(target, contents)

        if (executable) yield* fs.chmod(target, 0o755)
      }).pipe(Effect.uninterruptible, writes.withPermits(1))

    return yield* Effect.forEach(
      sources,
      ({ name, skills }) =>
        Effect.gen(function* () {
          const plugin = yield* inside(directory, name)

          const [, written] = yield* Effect.all(
            [
              write(
                join(plugin, ".claude-plugin", "plugin.json"),
                new TextEncoder().encode(JSON.stringify({ name })),
                false,
              ),
              Effect.forEach(
                skills,
                (skill) =>
                  Effect.gen(function* () {
                    const skillFolder = yield* inside(join(plugin, "skills"), skill.name)

                    yield* Effect.forEach(
                      skill.files,
                      ({ path, executable, contents }) =>
                        inside(skillFolder, path).pipe(
                          Effect.flatMap((target) => write(target, contents, executable)),
                        ),
                      { ...TOGETHER, discard: true },
                    )

                    return skillFolder
                  }),
                TOGETHER,
              ),
            ],
            TOGETHER,
          )

          return { plugin, skills: written }
        }),
      TOGETHER,
    )
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.logWarning("Couldn't write a Conversation's skills", cause).pipe(
        Effect.andThen(Effect.fail(couldNotWrite)),
      ),
    ),
  )
