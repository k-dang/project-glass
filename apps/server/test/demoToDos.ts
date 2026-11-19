import { GlassRpcs, RPC_PATH, TOKEN_PARAM, type ToDo } from "@glass/contracts"
import { Effect } from "effect"
import { connectRpcClient } from "../src/rpcSocket"

interface DemoToDo {
  readonly title: string
  readonly notes: string
}

const openDemoToDos: ReadonlyArray<DemoToDo> = [
  {
    title: "Write up the release checklist",
    notes:
      "Each release repeats the same steps from memory. A short checklist would make them easy to hand over: build, sign, upload, then announce.\nhttps://example.com/docs/guides/releases/checklists/release-checklist.png",
  },
  {
    title: "Compare two caching approaches",
    notes:
      "One keeps results in memory and is fast but forgets on restart. The other writes to disk and survives restarts but needs cleanup. Pick one before the next feature depends on it.",
  },
  {
    title: "Try a lighter sidebar layout",
    notes: "https://example.com/\nhttps://example.com/layouts#sidebar",
  },
  {
    title: "Book a room for the planning session",
    notes: "",
  },
  {
    title: "Decide where build logs belong",
    notes:
      "The build runs one command and streams its logs back. The steps are written up at https://example.com/docs/builds and the open question is whether those logs sit beside the project or on their own page.",
  },
  {
    title: "Reply to the review thread",
    notes: "",
  },
]

const doneDemoToDosNewestFirst: ReadonlyArray<DemoToDo> = [
  { title: "Send the weekly summary", notes: "" },
  {
    title: "Fix the wording on the settings page",
    notes: 'The page still says "plugin" where the rest of the app says "extension".',
  },
  {
    title: "Update the onboarding screenshots",
    notes: "https://example.com/docs/guides/onboarding/screenshots/first-run.png",
  },
  { title: "Clean up old branches", notes: "" },
]

const createdId = (list: ReadonlyArray<ToDo>, title: string) =>
  list.find((toDo) => toDo.title === title)?.id

export const seedDemoToDos = Effect.fnUntraced(function* (port: number, token: string) {
  const client = yield* connectRpcClient(
    GlassRpcs,
    `ws://127.0.0.1:${port}${RPC_PATH}?${TOKEN_PARAM}=${token}`,
  )

  if ((yield* client.ListToDos()).length > 0) return

  for (const toDo of openDemoToDos) {
    yield* client.AddToDo({ title: toDo.title, notes: toDo.notes })
  }

  const finished: Array<number> = []

  for (const toDo of doneDemoToDosNewestFirst) {
    const list = yield* client.AddToDo({ title: toDo.title, notes: toDo.notes })
    const id = createdId(list, toDo.title)

    if (id !== undefined) finished.push(id)
  }

  for (const id of finished.toReversed()) {
    yield* client.SetToDoDone({ id, done: true })
  }
})
