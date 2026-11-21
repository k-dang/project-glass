import { assert, it } from "@effect/vitest"
import { ToDo, ToDoError, type ToDoImageUpload } from "@glass/contracts"
import {
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  type FileSystem,
  Layer,
  PlatformError,
  Stream,
} from "effect"
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { eventually } from "../test/eventually"
import { isolatedHome, LAUNCH_TOKEN, startBackend } from "../test/harness"
import { wrappedFileSystem } from "../test/wrappedFileSystem"
import { ActivityLog } from "./ActivityLog"
import { DatabaseLive } from "./Database"
import { ServerConfig } from "./ServerConfig"
import { ToDos } from "./ToDos"

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

const imageRows = (home: string) =>
  Effect.sync(() => {
    const db = new DatabaseSync(join(home, ".project-glass", "glass.db"), { readOnly: true })

    try {
      return db
        .prepare("SELECT id, to_do_id, file_name, media_type FROM to_do_image ORDER BY id")
        .all()
        .map((row) => ({
          id: Number(row.id),
          to_do_id: Number(row.to_do_id),
          file_name: String(row.file_name),
          media_type: String(row.media_type),
        }))
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

        const removedFile = (yield* imageRows(home)).find((row) => row.id === 2)?.file_name
        const removed = yield* client.RemoveToDoImage({ id: 2 })
        assert.deepStrictEqual(
          removed[0]?.images.map(({ id }) => id),
          [1, 3],
        )
        assert.equal(removedFile === undefined, false)
        assert.deepStrictEqual(
          (yield* filesIn(home)).filter((name) => name.startsWith(removedFile ?? "")),
          [],
        )
      }),
    )

    yield* Effect.promise(() => writeFile(join(imageDir(home), "leftover"), "stale"))

    yield* Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* startBackend({}, home)
        assert.equal((yield* filesIn(home)).includes("leftover"), false)
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

it.live("still deletes a to-do when an image file cannot be removed", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    const { client } = yield* startBackend({}, home)
    yield* client.AddToDo({
      title: "Screenshot the dialog",
      notes: "",
      images: [shot("AQIDBA==")],
    })

    const stored = yield* imageRows(home)
    const fileName = stored[0]?.file_name

    if (fileName === undefined) throw new Error("missing image file")

    const blocked = join(imageDir(home), fileName)
    yield* Effect.promise(async () => {
      await rm(blocked)
      await mkdir(blocked)
      await writeFile(join(blocked, "kept"), "")
    })

    const removed = yield* client.DeleteToDo({ id: 1 })

    assert.deepStrictEqual(removed, [])
    assert.deepStrictEqual(yield* imageRows(home), [])
    assert.equal((yield* filesIn(home)).includes(fileName), true)

    const again = yield* client.AddToDo({
      title: "Next",
      notes: "",
      images: [{ ...shot("AQID"), data: "BQYH" }],
    })

    const created = again[0]?.images[0]

    if (created === undefined) throw new Error("missing image")

    assert.deepStrictEqual(yield* client.ReadToDoImage({ id: created.id, size: "full" }), {
      mediaType: "image/png",
      data: "BQYH",
    })
  }),
)

const unused = Effect.die("Not used by to-dos")

const toDosIn = Effect.fnUntraced(function* (
  home: string,
  wrap: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) {
  const services = yield* Layer.build(
    ToDos.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ActivityLog,
          ActivityLog.of({
            record: () => Effect.void,
            changes: Stream.empty,
            touchedPullRequests: () => unused,
            list: () => unused,
            stamps: () => unused,
          }),
        ),
      ),
      Layer.provide(DatabaseLive),
      Layer.provide(ServerConfig.layer),
      Layer.provide(wrappedFileSystem(wrap)),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            GLASS_PORT: "0",
            GLASS_TOKEN: LAUNCH_TOKEN,
            GLASS_HOME: home,
          }),
        ),
      ),
    ),
  )

  return Context.get(services, ToDos)
})

const mergedAt = (at: string) => [
  { conversationId: "merged", completedAt: DateTime.makeUnsafe(at) },
]

it.live(
  "marks a merged Conversation's to-dos done once, skipping ones the user finished first and merges from before the link",
  () =>
    Effect.gen(function* () {
      const toDos = yield* toDosIn(yield* isolatedHome, () => ({}))

      const merged = mergedAt("2100-01-01T00:00:00Z")

      yield* toDos.add("Fix spacing", "", [])
      yield* toDos.add("Rename the flag", "", [])
      yield* toDos.add("Tidy later", "", [])
      yield* toDos.linkConversation("merged", [1, 2])
      yield* toDos.setDone(2, true)
      yield* toDos.setDone(2, false)

      yield* toDos.completeLinked(mergedAt("2000-01-01T00:00:00Z"))
      assert.isFalse((yield* toDos.list()).some(({ done }) => done))

      yield* toDos.completeLinked(merged)
      assert.deepStrictEqual(yield* toDos.list(), [
        toDo(2, "Rename the flag"),
        toDo(3, "Tidy later"),
        toDo(1, "Fix spacing", true),
      ])

      yield* toDos.setDone(1, false)
      yield* toDos.completeLinked(merged)
      assert.deepStrictEqual(yield* toDos.list(), [
        toDo(1, "Fix spacing"),
        toDo(2, "Rename the flag"),
        toDo(3, "Tidy later"),
      ])
    }),
)

const heldWritesThatOutliveInterruption = Effect.gen(function* () {
  const gate = yield* Deferred.make<void>()
  let started = 0
  const events: Array<"wrote" | "removed"> = []

  const wrap =
    (refuse: (started: number) => boolean = () => false) =>
    (fs: FileSystem.FileSystem): Partial<FileSystem.FileSystem> => ({
      writeFile: (path, data, options) => {
        started += 1

        if (refuse(started))
          return Effect.fail(
            PlatformError.systemError({
              // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- systemError requires a reason tag option.
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "writeFile",
              pathOrDescriptor: path,
            }),
          )

        return Effect.callback<void, PlatformError.PlatformError>((resume) => {
          void Effect.runPromise(
            Deferred.await(gate).pipe(
              Effect.andThen(fs.writeFile(path, data, options)),
              Effect.ensuring(Effect.sync(() => events.push("wrote"))),
              Effect.exit,
            ),
          ).then(resume)
        })
      },
      remove: (path, options) =>
        Effect.sync(() => events.push("removed")).pipe(Effect.andThen(fs.remove(path, options))),
    })

  const startedAtLeast = (count: number) =>
    eventually(Effect.sync(() => assert.isAtLeast(started, count)))

  const removedAfterWriting = (count: number) =>
    eventually(
      Effect.sync(() => {
        assert.deepStrictEqual(events.slice(0, count), Array(count).fill("wrote"))
        assert.include(events, "removed")
      }),
    )

  return { gate, wrap, startedAtLeast, removedAfterWriting }
})

it.live("writes to-do image originals and thumbnails concurrently, keeping image order", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const writes = yield* heldWritesThatOutliveInterruption
    const toDos = yield* toDosIn(home, writes.wrap())
    const first = { ...shot("AQIDBA=="), data: "BQYH" }
    const second = shot("BAUGBw==")

    const adding = yield* Effect.forkChild(toDos.add("Screenshot the dialog", "", [first, second]))
    yield* writes.startedAtLeast(4)
    yield* Deferred.succeed(writes.gate, undefined)

    const added = yield* Fiber.join(adding)

    assert.deepStrictEqual(
      added[0]?.images.map(({ id }) => id),
      [1, 2],
    )
    assert.deepStrictEqual(yield* toDos.readImage(1, "full"), {
      mediaType: "image/png",
      data: "BQYH",
    })
    assert.deepStrictEqual(yield* toDos.readImage(2, "thumbnail"), {
      mediaType: "image/png",
      data: second.thumbnail,
    })
  }),
)

it.live("waits for writes in flight before cleaning up a to-do image that fails to save", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const writes = yield* heldWritesThatOutliveInterruption

    const toDos = yield* toDosIn(
      home,
      writes.wrap((started) => started === 4),
    )

    const adding = yield* Effect.forkChild(
      toDos.add("Screenshot the dialog", "", [shot("AQIDBA=="), shot("BAUGBw==")]),
    )

    yield* writes.startedAtLeast(4)
    yield* Deferred.succeed(writes.gate, undefined)
    assert.instanceOf(yield* Fiber.join(adding).pipe(Effect.flip), ToDoError)
    yield* writes.removedAfterWriting(3)
    assert.deepStrictEqual(yield* filesIn(home), [])
    assert.deepStrictEqual(yield* imageRows(home), [])
    assert.deepStrictEqual(yield* toDos.list(), [])
  }),
)

it.live("waits for writes in flight before cleaning up cancelled to-do images", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const writes = yield* heldWritesThatOutliveInterruption
    const toDos = yield* toDosIn(home, writes.wrap())

    yield* toDos.add("Keep me", "", [])

    const attaching = yield* Effect.forkChild(toDos.attach(1, [shot("AQIDBA==")]))
    yield* writes.startedAtLeast(2)
    attaching.interruptUnsafe()
    yield* Deferred.succeed(writes.gate, undefined)
    yield* Fiber.await(attaching)
    yield* writes.removedAfterWriting(2)

    assert.deepStrictEqual(yield* filesIn(home), [])
    assert.deepStrictEqual(yield* imageRows(home), [])
    assert.deepStrictEqual(yield* toDos.list(), [toDo(1, "Keep me")])
  }),
)

it.live("removes saved image files when attaching them to a to-do fails", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const toDos = yield* toDosIn(home, () => ({}))

    assert.instanceOf(yield* toDos.attach(7, [shot("AQIDBA==")]).pipe(Effect.flip), ToDoError)
    assert.deepStrictEqual(yield* filesIn(home), [])
    assert.deepStrictEqual(yield* imageRows(home), [])
  }),
)
