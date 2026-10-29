// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { type AskAnswer, AskFailure, Revision } from "@glass/contracts"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { LineAsk } from "./Asks"
import { AskStore } from "./useAsks"
import { type Handlers, hold, type Held, next, testRegistry } from "../../test/testBackend"
import { workspace } from "../../test/workspace"

type Asked = Held<Parameters<Handlers["Ask"]>[0], AskAnswer, AskFailure>

const answer: AskAnswer = {
  answer: "`main.ts` calls `greet` without a name.",
  runner: { engine: "claude-code", model: "anthropic/claude-sonnet-5-5" },
}

const registries: Array<ReturnType<typeof testRegistry>> = []

afterEach(() => {
  cleanup()

  for (const registry of registries.splice(0)) registry.dispose()
})

const setup = (handlers: Partial<Handlers>) => {
  const registry = testRegistry(handlers)
  registries.push(registry)
  const store = new AskStore(workspace(), registry)
  store.ask({ path: "greet.ts", side: "new", line: 2 }, "  Who calls this?\n")
  const key = store.registry.get(store.placesAtom)[0]!.key

  render(
    <RegistryContext.Provider value={registry}>
      <LineAsk store={store} askKey={key} />
    </RegistryContext.Provider>,
  )

  return { store, key, user: userEvent.setup() }
}

it("asks about a line privately and shows the answer with who wrote it", async () => {
  const asked: Array<Asked> = []
  const { store, user } = setup({ Ask: hold(asked) })

  const call = await next(asked)

  expect(call.payload.place).toEqual({ path: "greet.ts", side: "new", line: 2 })
  expect(call.payload.question).toBe("Who calls this?")
  expect(screen.getByText("The agent is reading the PR's code…")).toBeDefined()
  expect(screen.getByText("Only you can see this")).toBeDefined()

  call.answer(Effect.succeed(answer))

  expect(await screen.findByText("main.ts")).toBeDefined()
  expect(screen.getByText("Who calls this?")).toBeDefined()
  expect(screen.getByText("Claude Code · anthropic/claude-sonnet-5-5")).toBeDefined()

  await user.click(screen.getByRole("button", { name: "Dismiss answer on greet.ts line +2" }))
  expect(store.registry.get(store.placesAtom)).toEqual([])
})

it("doesn't ask an empty question", () => {
  const asked: Array<Asked> = []
  const registry = testRegistry({ Ask: hold(asked) })
  registries.push(registry)
  const store = new AskStore(workspace(), registry)

  store.ask({ path: "greet.ts", side: "new", line: 2 }, "   ")

  expect(store.registry.get(store.placesAtom)).toEqual([])
  expect(asked).toEqual([])
})

it("cancels a pending question, interrupting the call", async () => {
  let interrupted = false

  const { store, user } = setup({
    Ask: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))),
  })

  await user.click(
    await screen.findByRole("button", { name: "Cancel question on greet.ts line +2" }),
  )

  expect(store.registry.get(store.placesAtom)).toEqual([])
  await waitFor(() => expect(interrupted).toBe(true))
})

it("says why a question failed and retries it", async () => {
  const asked: Array<Asked> = []
  const { user } = setup({ Ask: hold(asked) })

  const message = "The agent took too long writing the answer. Try again."

  ;(await next(asked)).answer(
    Effect.fail(new AskFailure({ reason: "timeout", message, runner: null })),
  )

  expect(await screen.findByText(message)).toBeDefined()
  await user.click(screen.getByRole("button", { name: "Retry" }))

  const retried = await next(asked)
  expect(retried.payload.question).toBe("Who calls this?")
  retried.answer(Effect.succeed(answer))
  expect(await screen.findByText("main.ts")).toBeDefined()
})

it("keeps answered questions whenever the PR opens again on its Revision", async () => {
  const registry = testRegistry({
    Ask: ({ place }) => (place.line === 2 ? Effect.succeed(answer) : Effect.never),
  })

  registries.push(registry)
  const first = new AskStore(workspace(), registry)

  first.ask({ path: "greet.ts", side: "new", line: 2 }, "Who calls this?")
  first.ask({ path: "greet.ts", side: "new", line: 3 }, "And this?")
  const [asked, pending] = registry.get(first.placesAtom)
  await waitFor(() => expect(first.view(asked!.key)?.state.status).toBe("answered"))

  first.dispose()

  const reopened = new AskStore(workspace(), registry)
  expect(registry.get(reopened.placesAtom).map(({ key }) => key)).toEqual([asked!.key])
  expect(reopened.view(pending!.key)).toBeUndefined()

  const newer = workspace([], { revision: new Revision({ base: "b0", head: "h2" }) })
  expect(registry.get(new AskStore(newer, registry).placesAtom)).toEqual([])
})
