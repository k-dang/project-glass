import { assert, it } from "@effect/vitest"
import { fileMention, mentionedToDoIds, mentionsIn, toDoMention } from "@glass/contracts"

it("lists each mentioned To-do once, in the order the message first mentions it", () => {
  const ship = toDoMention({ id: 7, title: "Ship docs" })
  const fix = toDoMention({ id: 3, title: "Fix the test" })

  assert.deepStrictEqual(
    mentionedToDoIds(`${ship}, ${fileMention("docs/ship.md")}, ${fix}, then ${ship} again`),
    [7, 3],
  )
})

it("reads back a mentioned file's path, whatever characters it holds", () => {
  const path = "src/[id]/my (copy) 100%.ts"

  assert.deepStrictEqual(mentionsIn(`See ${fileMention(path)}`), [{ kind: "file", path }])
})

it("leaves a link Glass didn't write as text", () => {
  assert.deepStrictEqual(mentionsIn("[a](glass://file/%E0%A4%A) [b](glass://to-do/abc)"), [])
})
