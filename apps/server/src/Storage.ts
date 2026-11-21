import { type StorageGroup, StorageError, StorageItem } from "@glass/contracts"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { Worker } from "node:worker_threads"
import { join } from "node:path"
import { databaseFile } from "./Database"
import { bundledEntry } from "./processes"
import { ServerConfig } from "./ServerConfig"

const FREE_SPACE = "Free space"

const WRITE_AHEAD_LOG = "Write-ahead log"

const measurement = `
  SELECT COALESCE(object.tbl_name, page.name) AS name, SUM(page.pgsize) AS bytes
  FROM dbstat('main', 1) AS page
  LEFT JOIN sqlite_schema AS object ON object.name = page.name
  GROUP BY 1
  UNION ALL
  SELECT '${FREE_SPACE}', freelist_count * page_size FROM pragma_freelist_count, pragma_page_size
`

const decodeMeasured = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String, bytes: Schema.Int })),
)

const groupOfItem = new Map<string, StorageGroup>([
  ["thread", "threads"],
  ["thread_turn", "threads"],
  ["thread_turn_part", "threads"],
  ["thread_queued_message", "threads"],
  ["thread_unsent_message", "threads"],
  ["feedback_note", "threads"],
  ["local_checkout", "threads"],
  ["global_chat", "threads"],
  ["global_chat_session", "threads"],
  ["started_thread", "threads"],
  ["started_agent_review", "threads"],
  ["skill_pack", "threads"],
  ["skill_pack_pin", "threads"],
  ["skill_pack_skill", "threads"],
  ["skill_pack_file", "threads"],
  ["thread_skill_pack", "threads"],
  ["agent_reviews", "reviews"],
  ["queued_pull_request", "reviews"],
  ["tours", "reviews"],
  ["activity", "activity"],
  ["to_do", "toDos"],
  ["to_do_image", "toDos"],
  ["thread_to_do", "toDos"],
  ["To-do images", "toDos"],
  [FREE_SPACE, "overhead"],
  [WRITE_AHEAD_LOG, "overhead"],
])

const sumBytes = (sizes: ReadonlyArray<number>) => sizes.reduce((sum, bytes) => sum + bytes, 0)

const readOffThread = (file: string, query: string) =>
  Effect.callback<unknown, Error>((resume) => {
    const worker = new Worker(bundledEntry("sqlReadWorker", import.meta.url), {
      workerData: { file, query },
    })

    worker.once("message", (rows) => resume(Effect.succeed(rows)))
    worker.once("error", (cause) => resume(Effect.fail(cause)))

    return Effect.promise(() => worker.terminate())
  })

export class Storage extends Context.Service<
  Storage,
  { readonly breakdown: Effect.Effect<ReadonlyArray<StorageItem>, StorageError> }
>()("@glass/server/Storage") {
  static readonly layer = Layer.effect(
    Storage,
    Effect.gen(function* () {
      const { dataDirectory } = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const file = databaseFile(dataDirectory)

      const fileBytes = (path: string) =>
        fs.stat(path).pipe(
          Effect.map(({ size }) => Number(size)),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(0)),
        )

      const breakdown = Effect.gen(function* () {
        const measured = yield* readOffThread(file, measurement).pipe(
          Effect.flatMap(decodeMeasured),
        )

        const fileSizes = yield* Effect.forEach(
          ["", "-wal", "-shm"],
          (suffix) => fileBytes(`${file}${suffix}`),
          { concurrency: "unbounded" },
        )

        const imageNames = yield* fs
          .readDirectory(join(dataDirectory, "to-do-images"))
          .pipe(Effect.orElseSucceed(() => []))

        const imageBytes = sumBytes(
          yield* Effect.forEach(
            imageNames,
            (name) => fileBytes(join(dataDirectory, "to-do-images", name)),
            { concurrency: "unbounded" },
          ),
        )

        const logBytes = sumBytes(fileSizes) - sumBytes(measured.map(({ bytes }) => bytes))

        return [
          ...measured,
          { name: WRITE_AHEAD_LOG, bytes: Math.max(logBytes, 0) },
          { name: "To-do images", bytes: imageBytes },
        ].map(
          ({ name, bytes }) =>
            new StorageItem({ name, bytes, group: groupOfItem.get(name) ?? "internals" }),
        )
      }).pipe(
        Effect.withSpan("Storage.breakdown"),
        Effect.tapError((cause) => Effect.logWarning("Couldn't measure the database", cause)),
        Effect.mapError(() => new StorageError()),
      )

      return Storage.of({ breakdown })
    }),
  )
}
