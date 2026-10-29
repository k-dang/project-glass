// @vitest-environment happy-dom
import { PullRequest } from "@glass/contracts"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { Toaster } from "@/components/ui/toast"
import { pullRequestFields } from "../../test/workspace"
import { CopyMenu } from "./CopyMenu"
import { OpenPullRequestDialog } from "./OpenPullRequestDialog"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const pullRequest = new PullRequest({
  ...pullRequestFields,
  title: "Fix <special> titles & things",
  headBranch: "feature/copy",
})

function mount() {
  const user = userEvent.setup()
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()

  const view = render(
    <Toaster>
      <button>Before</button>
      <button>After</button>
      <textarea aria-label="Draft" />
      <OpenPullRequestDialog current={pullRequest.ref} onOpen={() => {}} />
      <CopyMenu pullRequest={pullRequest} />
    </Toaster>,
  )

  return { user, write, ...view }
}

it("copies each exact value with C then its key, with success feedback and focus restored", async () => {
  const { user, write } = mount()
  const opener = screen.getByRole("button", { name: "Before" })
  await user.click(opener)

  for (const { key, value, message } of [
    { key: "g", value: pullRequest.url, message: "PR link copied" },
    { key: "t", value: pullRequest.title, message: "Title copied" },
    { key: "b", value: pullRequest.headBranch, message: "Branch name copied" },
    { key: "c", value: `gh pr checkout ${pullRequest.url}`, message: "Checkout command copied" },
  ]) {
    await user.keyboard("c")
    const menu = await screen.findByRole("dialog", { name: "Copy" })
    await waitFor(() => expect(document.activeElement).toBe(menu))
    await user.keyboard(key)
    expect(write).toHaveBeenLastCalledWith(value)
    await screen.findByText(message)
    expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(opener))
  }
})

it("dismisses on Escape, consumes unknown keys, and keeps normal Tab order", async () => {
  const { user, write } = mount()
  const opener = screen.getByRole("button", { name: "Before" })
  const after = screen.getByRole("button", { name: "After" })
  await user.click(opener)
  await user.keyboard("c{Escape}")
  await waitFor(() => expect(document.activeElement).toBe(opener))
  await user.keyboard("c")
  const menu = await screen.findByRole("dialog", { name: "Copy" })
  expect(fireEvent.keyDown(menu, { key: "x" })).toBe(false)
  expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(opener))
  await user.keyboard("c{Tab}")
  expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(after))
  expect(write).not.toHaveBeenCalled()
})

it("leaves typing and other dialogs alone, and preserves Cmd/Ctrl+L from the menu", async () => {
  const { user, write } = mount()
  await user.type(screen.getByRole("textbox", { name: "Draft" }), "cl")
  expect(screen.queryByRole("dialog")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Before" }))
  await user.keyboard("c{Control>}l{/Control}")
  const input = await screen.findByRole("textbox", { name: "Open a PR" })
  await waitFor(() => expect(document.activeElement).toBe(input))
  expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
  await user.keyboard("c")
  expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
  expect(write).not.toHaveBeenCalled()
})

it("dismisses on an outside click without activating a copy row", async () => {
  const { user, write } = mount()
  await user.keyboard("c")
  await user.click(await screen.findByText("Copy title"))
  expect(write).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "After" }))
  expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
})

it("keeps failures open for retry and ignores repeats and composition", async () => {
  const { user, write } = mount()
  write.mockRejectedValueOnce(new Error("Clipboard unavailable"))
  await user.keyboard("c")
  const menu = await screen.findByRole("dialog", { name: "Copy" })
  fireEvent.keyDown(menu, { key: "g", repeat: true })
  fireEvent.keyDown(menu, { key: "g", isComposing: true })
  expect(write).not.toHaveBeenCalled()
  await user.keyboard("g")
  await screen.findByRole("alert")
  expect(screen.getByRole("dialog", { name: "Copy" })).toBe(menu)
  await user.keyboard("g")
  await screen.findByText("PR link copied")
  expect(write).toHaveBeenCalledTimes(2)
})

it("ignores repeated, composing, and consumed Escape through Base UI dismissal", async () => {
  const { user } = mount()
  await user.keyboard("c")
  const menu = await screen.findByRole("dialog", { name: "Copy" })
  await waitFor(() => expect(document.activeElement).toBe(menu))

  for (const target of [menu, document]) {
    for (const options of [{ repeat: true }, { isComposing: true }, { consumed: true }]) {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        ...options,
      })

      if ("consumed" in options) event.preventDefault()
      fireEvent(target, event)
      expect(screen.getByRole("dialog", { name: "Copy" })).toBe(menu)
    }
  }

  await user.keyboard("{Escape}")
  expect(screen.queryByRole("dialog", { name: "Copy" })).toBeNull()
})

it("allows only one pending write and ignores its result after leaving the workspace", async () => {
  const { user, write, unmount } = mount()
  const pending = Promise.withResolvers<void>()
  write.mockReturnValueOnce(pending.promise)
  await user.keyboard("cgt")
  expect(write).toHaveBeenCalledTimes(1)
  unmount()
  await act(async () => pending.resolve())
  await user.keyboard("cg")
  expect(write).toHaveBeenCalledTimes(1)
})
