import { GlassRpcs, RPC_PATH, TOKEN_PARAM, type ToDo } from "@glass/contracts"
import { Effect } from "effect"
import { connectRpcClient } from "../src/rpcSocket"

interface DemoToDo {
  readonly title: string
  readonly notes: string
}

const openDemoToDos: ReadonlyArray<DemoToDo> = [
  {
    title: "[glass] dedicated show me artifacts / flow diagrams on tours",
    notes:
      "A Tour should open its diagram beside the chat, the same way a review pins a file. The reading order is the hard part: the map has to stay put while the chapter changes.\nhttps://bennettaur.github.io/yarvis/artifacts-beside-the-chat/02-diagram-beside-the-chat.png",
  },
  {
    title: "Implement our own version of lavish, does it fit well inside of project-glass?",
    notes:
      "Lavish presents an agent trace as a small stage. Glass already has a transcript and a Tour overview, so a copy has to earn its place: either it shows a run more clearly than the transcript, or it should stay out.",
  },
  {
    title: "glass redesign?",
    notes: "https://capy.ai/\nhttps://ui.shadcn.com/blocks/sidebar#sidebar-08",
  },
  {
    title: "Use vercel sandbox as a provider plugin",
    notes: "",
  },
  {
    title: "Decide where sandbox logs belong",
    notes:
      "The provider boots a sandbox, runs one command, and streams logs back into the Conversation. The lifecycle is written up at https://vercel.com/docs/sandbox and the open question is whether those logs sit beside the local checkout or in their own plugin.",
  },
  {
    title: "Reply to the sidebar thread",
    notes: "",
  },
]

// Listed in the order Done shows them. The server sorts finished to-dos by
// completed_at descending, so these are marked done from the bottom up.
const doneDemoToDos: ReadonlyArray<DemoToDo> = [
  { title: "Task 1", notes: "" },
  {
    title: "Fix the copy prompt for glass/plugins",
    notes: 'The prompt still says "plugin" where the UI says "skill pack".',
  },
  {
    title: "[glass] Some sort of artifacts beside a chat/review",
    notes:
      "https://bennettaur.github.io/yarvis/artifacts-beside-the-chat/02-diagram-beside-the-chat.png",
  },
  { title: "Task 2", notes: "" },
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

  for (const toDo of doneDemoToDos) {
    const list = yield* client.AddToDo({ title: toDo.title, notes: toDo.notes })
    const id = createdId(list, toDo.title)

    if (id !== undefined) finished.push(id)
  }

  for (const id of finished.toReversed()) {
    yield* client.SetToDoDone({ id, done: true })
  }
})
