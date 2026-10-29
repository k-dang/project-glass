import { assert, it } from "@effect/vitest"
import { ToDo } from "@glass/contracts"
import { Effect } from "effect"
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

        yield* client.AddToDo({ title: "Write the release notes" })
        yield* client.AddToDo({ title: "Follow up on #42" })
        assert.deepStrictEqual(yield* client.AddToDo({ title: "Rebase the branch" }), [
          toDo(1, "Write the release notes"),
          toDo(2, "Follow up on #42"),
          toDo(3, "Rebase the branch"),
        ])

        assert.deepStrictEqual(yield* client.SetToDoDone({ id: 1, done: true }), [
          toDo(2, "Follow up on #42"),
          toDo(3, "Rebase the branch"),
          toDo(1, "Write the release notes", true),
        ])

        yield* client.EditToDo({ id: 2, title: "Follow up on #43", notes: "After CI\npasses" })
        yield* client.DeleteToDo({ id: 3 })
      }),
    )

    const { client } = yield* startBackend({}, home)
    assert.deepStrictEqual(yield* client.ListToDos(), [
      toDo(2, "Follow up on #43", false, "After CI\npasses"),
      toDo(1, "Write the release notes", true),
    ])
    assert.deepStrictEqual(yield* client.SetToDoDone({ id: 1, done: false }), [
      toDo(1, "Write the release notes"),
      toDo(2, "Follow up on #43", false, "After CI\npasses"),
    ])
  }),
)
