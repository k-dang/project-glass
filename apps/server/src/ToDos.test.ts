import { assert, it } from "@effect/vitest"
import { ToDo, ToDoError, type ToDoImageUpload } from "@glass/contracts"
import { Effect, Result } from "effect"
import { Base64 } from "effect/encoding"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isolatedHome, startBackend } from "../test/harness"

const toDo = (id: number, title: string, done = false, notes = "") =>
  new ToDo({ id, title, notes, done })

it.live("keeps open to-dos in the order added, above done ones, across restarts", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* startBackend({}, home)
        assert.deepStrictEqual(yield* client.ListToDos(), [])

        yield* client.AddToDo({ title: "Write the release notes", notes: "" })
        yield* client.AddToDo({ title: "Follow up on #42", notes: "" })
        assert.deepStrictEqual(
          yield* client.AddToDo({ title: "Rebase the branch", notes: "Onto main" }),
          [
            toDo(1, "Write the release notes"),
            toDo(2, "Follow up on #42"),
            toDo(3, "Rebase the branch", false, "Onto main"),
          ],
        )
        yield* client.AddToDo({ title: "Ship the flag", notes: "Mention the flag" })

        assert.deepStrictEqual(yield* client.SetToDoDone({ id: 1, done: true }), [
          toDo(2, "Follow up on #42"),
          toDo(3, "Rebase the branch", false, "Onto main"),
          toDo(4, "Ship the flag", false, "Mention the flag"),
          toDo(1, "Write the release notes", true),
        ])

        yield* client.EditToDo({ id: 2, title: "Follow up on #43", notes: "After CI\npasses" })
        yield* client.DeleteToDo({ id: 3 })
      }),
    )

    const { client } = yield* startBackend({}, home)
    assert.deepStrictEqual(yield* client.ListToDos(), [
      toDo(2, "Follow up on #43", false, "After CI\npasses"),
      toDo(4, "Ship the flag", false, "Mention the flag"),
      toDo(1, "Write the release notes", true),
    ])
    assert.deepStrictEqual(yield* client.SetToDoDone({ id: 1, done: false }), [
      toDo(1, "Write the release notes"),
      toDo(2, "Follow up on #43", false, "After CI\npasses"),
      toDo(4, "Ship the flag", false, "Mention the flag"),
    ])
  }),
)

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const shot = (thumbnail: string): ToDoImageUpload => ({
  mediaType: "image/png",
  data: png,
  thumbnail,
  thumbnailMediaType: "image/png",
})

const imageDir = (home: string) => join(home, ".project-glass", "to-do-images")

const filesIn = (home: string) =>
  Effect.promise(async () => {
    try {
      return await readdir(imageDir(home))
    } catch {
      return []
    }
  })

const bytesOf = (home: string, name: string) =>
  Effect.promise(() => readFile(join(imageDir(home), name)))

const decoded = (encoded: string) => {
  const result = Base64.decode(encoded)

  if (Result.isFailure(result)) throw new Error("test image is not base64")

  return result.success
}

const imageRows = (home: string) =>
  Effect.sync(() => {
    const db = new DatabaseSync(join(home, ".project-glass", "glass.db"), { readOnly: true })

    try {
      const rows = db.prepare("SELECT id, to_do_id, media_type FROM to_do_image ORDER BY id").all()

      return rows
    } finally {
      db.close()
    }
  })

it.live("keeps pasted images with a to-do until they are removed or the to-do is deleted", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const first = shot("AQIDBA==")
    const second = shot("BAUGBw==")
    const third = shot("CAkKCw==")

    yield* Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* startBackend({}, home)

        const added = yield* client.AddToDo({
          title: "Screenshot the dialog",
          notes: "Red button",
          images: [first, second],
        })

        assert.deepStrictEqual(added, [
          new ToDo({
            id: 1,
            title: "Screenshot the dialog",
            notes: "Red button",
            done: false,
            images: [
              { id: 1, mediaType: "image/png" },
              { id: 2, mediaType: "image/png" },
            ],
          }),
        ])
        assert.deepStrictEqual(yield* bytesOf(home, "1"), Buffer.from(decoded(png)))
        assert.deepStrictEqual(
          yield* bytesOf(home, "1.thumb"),
          Buffer.from(decoded(first.thumbnail)),
        )
        assert.deepStrictEqual(yield* client.ReadToDoImage({ id: 1, size: "full" }), {
          mediaType: "image/png",
          data: png,
        })
        assert.deepStrictEqual(yield* client.ReadToDoImage({ id: 2, size: "thumbnail" }), {
          mediaType: "image/png",
          data: second.thumbnail,
        })

        const plain = yield* client.AddToDo({ title: "No picture", notes: "" })
        assert.deepStrictEqual(plain[1], toDo(2, "No picture"))

        const attached = yield* client.AttachToDoImages({ id: 1, images: [third] })
        assert.deepStrictEqual(
          attached[0]?.images.map(({ id }) => id),
          [1, 2, 3],
        )

        const removed = yield* client.RemoveToDoImage({ id: 2 })
        assert.deepStrictEqual(
          removed[0]?.images.map(({ id }) => id),
          [1, 3],
        )
        assert.deepStrictEqual(
          (yield* filesIn(home)).filter((name) => name.startsWith("2")),
          [],
        )
      }),
    )

    yield* Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* startBackend({}, home)
        assert.deepStrictEqual(
          (yield* client.ListToDos())[0]?.images.map(({ id }) => id),
          [1, 3],
        )
        assert.deepStrictEqual(yield* client.ReadToDoImage({ id: 3, size: "full" }), {
          mediaType: "image/png",
          data: png,
        })

        yield* client.DeleteToDo({ id: 1 })
        assert.deepStrictEqual(yield* client.ListToDos(), [toDo(2, "No picture")])
      }),
    )

    assert.deepStrictEqual(yield* filesIn(home), [])
    assert.deepStrictEqual(yield* imageRows(home), [])
  }),
)

it.live("leaves no image files when saving a to-do with images fails", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const directory = join(home, ".project-glass")

    yield* Effect.promise(() => mkdir(directory, { recursive: true }))
    yield* Effect.promise(() => writeFile(join(directory, "to-do-images"), "not a directory"))

    const { client } = yield* startBackend({}, home)
    yield* client.AddToDo({ title: "Keep me", notes: "" })

    const failed = yield* client
      .AddToDo({ title: "Screenshot the dialog", notes: "", images: [shot("@@@")] })
      .pipe(Effect.flip)

    const blocked = yield* client
      .AddToDo({ title: "Another shot", notes: "", images: [shot("AQIDBA==")] })
      .pipe(Effect.flip)

    assert.instanceOf(failed, ToDoError)
    assert.instanceOf(blocked, ToDoError)
    assert.deepStrictEqual(yield* client.ListToDos(), [toDo(1, "Keep me")])
    assert.isTrue((yield* Effect.promise(() => stat(join(directory, "to-do-images")))).isFile())
    assert.deepStrictEqual(yield* imageRows(home), [])
  }),
)
