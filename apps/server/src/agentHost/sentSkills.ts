import { Effect, FileSystem, type Scope } from "effect"
import { randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, relative } from "node:path"
import { HostConversationError, type SkillSource } from "./protocol"
import { scopedFolder } from "./scopedFolder"

export interface WrittenSkills {
  readonly plugin: string
  readonly skills: ReadonlyArray<string>
}

const WRITES_AT_ONCE = 8

const couldNotWrite = new HostConversationError({
  message: "Glass couldn't write the Conversation's skills. Try again.",
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
  HostConversationError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    if (sources.length === 0) return []

    const fs = yield* FileSystem.FileSystem
    const directory = yield* scopedFolder(`${folder}.skills-${randomUUID()}`)
    const files: Array<{ target: string; contents: Uint8Array; executable: boolean }> = []

    const written = yield* Effect.forEach(sources, ({ name, skills }) =>
      Effect.gen(function* () {
        const plugin = yield* inside(directory, name)

        files.push({
          target: join(plugin, ".claude-plugin", "plugin.json"),
          contents: new TextEncoder().encode(JSON.stringify({ name })),
          executable: false,
        })

        const skillFolders = yield* Effect.forEach(skills, (skill) =>
          Effect.gen(function* () {
            const skillFolder = yield* inside(join(plugin, "skills"), skill.name)

            for (const { path, executable, contents } of skill.files)
              files.push({ target: yield* inside(skillFolder, path), contents, executable })

            return skillFolder
          }),
        )

        return { plugin, skills: skillFolders }
      }),
    )

    yield* Effect.forEach(
      files,
      ({ target, contents, executable }) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(target), { recursive: true })
          yield* fs.writeFile(target, contents)

          if (executable) yield* fs.chmod(target, 0o755)
        }).pipe(Effect.uninterruptible),
      { concurrency: WRITES_AT_ONCE, discard: true },
    )

    return written
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.logWarning("Couldn't write a Conversation's skills", cause).pipe(
        Effect.andThen(Effect.fail(couldNotWrite)),
      ),
    ),
  )
