// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import { PullRequestRef } from "@glass/contracts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { type Action, useActions } from "./actions"
import { CommandMenu, pastedRows } from "./CommandMenu"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Registers(props: { actions: ReadonlyArray<Action> }) {
  useActions(props.actions)

  return null
}

function mount(props: { actions?: ReadonlyArray<Action>; extra?: ReadonlyArray<Action> } = {}) {
  const user = userEvent.setup()
  const onOpen = vi.fn<(ref: PullRequestRef) => void>()

  const view = render(
    <RegistryProvider>
      <button>Opener</button>
      <Registers actions={props.actions ?? []} />
      {props.extra && <Registers actions={props.extra} />}
      <CommandMenu
        current={undefined}
        onOpen={onOpen}
        onOpenThread={() => {}}
        onViewQueue={() => {}}
      />
    </RegistryProvider>,
  )

  return { user, onOpen, ...view }
}

const action = (id: string, title: string, group: Action["group"], run = () => {}): Action => ({
  id,
  title,
  group,
  run,
})

const options = () =>
  within(screen.getByRole("listbox"))
    .queryAllByRole("option")
    .map((option) => option.textContent)

it("runs the chosen action once the menu closes, and returns focus to where it was", async () => {
  const run = vi.fn<() => void>()
  const { user } = mount({ actions: [action("inbox", "Inbox", "Go to", run)] })
  const opener = screen.getByRole("button", { name: "Opener" })
  await user.click(opener)

  await user.keyboard("{Control>}k{/Control}")
  const input = await screen.findByRole("combobox", { name: "Search actions, or paste a PR" })
  await waitFor(() => expect(document.activeElement).toBe(input))
  await user.keyboard("inb{Enter}")

  await waitFor(() => expect(run).toHaveBeenCalledOnce())
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(opener)
})

it("lists only mounted actions, in group order", async () => {
  const { user, rerender } = mount({
    actions: [action("settings", "Settings", "Go to")],
    extra: [action("agent-review", "Open the Agent review", "Pull request")],
  })

  await user.keyboard("{Control>}k{/Control}")
  await screen.findByRole("dialog", { name: "Command menu" })
  expect(options()).toEqual(["Open the Agent review", "Settings"])

  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  rerender(
    <RegistryProvider>
      <Registers actions={[action("settings", "Settings", "Go to")]} />
      <CommandMenu
        current={undefined}
        onOpen={() => {}}
        onOpenThread={() => {}}
        onViewQueue={() => {}}
      />
    </RegistryProvider>,
  )
  await user.keyboard("{Control>}k{/Control}")
  await screen.findByRole("dialog", { name: "Command menu" })
  expect(options()).toEqual(["Settings"])
})

it("narrows by search and says when nothing matches", async () => {
  const { user } = mount({
    actions: [action("inbox", "Inbox", "Go to"), action("settings", "Settings", "Go to")],
  })

  await user.keyboard("{Control>}k{/Control}")
  await user.keyboard("sett")
  await waitFor(() => expect(options()).toEqual(["Settings"]))
  await user.keyboard("zzz")
  await screen.findByText(/Nothing matches/)
})

it("opens a PR reference typed or pasted into the search with Enter", async () => {
  const { user, onOpen } = mount({ actions: [action("inbox", "Inbox", "Go to")] })

  await user.keyboard("{Control>}k{/Control}")
  await user.keyboard("https://github.com/octo-org/glass/pull/42")
  expect(options()).toEqual([
    "Open octo-org/glass#42",
    expect.stringMatching(/^Add octo-org\/glass#42 to the Queue/),
  ])
  await user.keyboard("{Enter}")

  await waitFor(() =>
    expect(onOpen).toHaveBeenCalledWith(
      new PullRequestRef({ owner: "octo-org", repo: "glass", number: 42 }),
    ),
  )
})

it("lists recently run actions first while the search is empty", async () => {
  const { user } = mount({
    actions: [action("inbox", "Inbox", "Go to"), action("settings", "Settings", "Go to")],
  })

  await user.keyboard("{Control>}k{/Control}")
  expect(options()).toEqual(["Inbox", "Settings"])
  await user.keyboard("sett{Enter}")
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

  await user.keyboard("{Control>}k{/Control}")
  await screen.findByRole("dialog", { name: "Command menu" })
  expect(options()).toEqual(["Settings", "Inbox", "Settings"])
  expect(screen.getByRole("group", { name: "Recent" })).toBeTruthy()
})

it("highlights the first action on open, so Enter runs it", async () => {
  const run = vi.fn<() => void>()
  const { user } = mount({ actions: [action("inbox", "Inbox", "Go to", run)] })

  await user.keyboard("{Control>}k{/Control}")
  await screen.findByRole("dialog", { name: "Command menu" })
  await user.keyboard("{Enter}")
  await waitFor(() => expect(run).toHaveBeenCalledOnce())
})

const titles = (query: string, current?: PullRequestRef) => {
  const { open, queue } = pastedRows(
    query,
    current,
    () => {},
    () => {},
  )

  return [open?.title, queue?.title]
}

it("offers Open and Add to the Queue for one pasted PR, and one Queue row for several", () => {
  const ref = new PullRequestRef({ owner: "octo-org", repo: "glass", number: 42 })

  expect(titles("octo-org/glass#42")).toEqual([
    "Open octo-org/glass#42",
    "Add octo-org/glass#42 to the Queue",
  ])
  expect(titles("octo-org/glass#42", ref)).toEqual([
    undefined,
    "Add octo-org/glass#42 to the Queue",
  ])
  expect(titles("octo-org/glass#42 octo-org/glass#7")).toEqual([
    undefined,
    "Queue 2 PRs: octo-org/glass#42, octo-org/glass#7",
  ])
  expect(titles("inbox")).toEqual([undefined, undefined])
})
