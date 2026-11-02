import { assert, it } from "@effect/vitest"
import { mentionedToDoIds, toDoMention } from "@glass/contracts"

it("lists each mentioned To-do once, in the order the message first mentions it", () => {
  const ship = toDoMention({ id: 7, title: "Ship docs" })
  const fix = toDoMention({ id: 3, title: "Fix the test" })

  assert.deepStrictEqual(mentionedToDoIds(`${ship}, ${fix}, then ${ship} again`), [7, 3])
})
