import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { startBackend } from "../test/harness"

it.live("measures the database by table, counting each index toward its table", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { client } = yield* startBackend({})
      yield* client.AddToDo({
        title: "Measure storage",
        notes: "",
        images: [
          {
            mediaType: "image/png",
            data: "AQIDBA==",
            thumbnail: "BQYH",
            thumbnailMediaType: "image/png",
          },
        ],
      })

      const items = yield* client.GetStorageBreakdown()

      assert.sameMembers(
        items.filter(({ group }) => group === "internals").map(({ name }) => name),
        ["effect_sql_migrations", "outside_agent", "saved_place", "sqlite_schema"],
      )

      const bytesOf = (item: string) => items.find(({ name }) => name === item)?.bytes ?? 0

      assert.isAbove(bytesOf("to_do"), 0)
      assert.isAbove(bytesOf("To-do images"), 0)
      assert.equal(items.find(({ name }) => name === "To-do images")?.group, "toDos")
      assert.isAbove(bytesOf("sqlite_schema"), 0)
      assert.isAbove(bytesOf("activity"), bytesOf("to_do"))
      assert.isEmpty(items.filter(({ name }) => /^(activity_login_|sqlite_autoindex_)/.test(name)))
      assert.isAbove(bytesOf("Write-ahead log"), 0)
    }),
  ),
)
