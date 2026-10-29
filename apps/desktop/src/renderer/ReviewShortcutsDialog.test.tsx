// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { BackToPullRequests } from "./BackToPullRequests"
import { ReviewShortcutsDialog } from "./ReviewShortcutsDialog"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("opens with Shift+? and Escape returns focus without leaving the PR workspace", async () => {
  const user = userEvent.setup()
  const back = vi.fn<() => void>()
  render(
    <>
      <BackToPullRequests onBack={back} />
      <button>Read diff</button>
      <ReviewShortcutsDialog />
    </>,
  )
  const opener = screen.getByRole("button", { name: "Read diff" })
  await user.click(opener)
  fireEvent.keyDown(opener, { key: "?", shiftKey: true })
  await screen.findByRole("dialog", { name: "Keyboard shortcuts" })
  const search = screen.getByRole("textbox", { name: "Search keyboard shortcuts" })
  await waitFor(() => expect(document.activeElement).toBe(search))

  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(opener))
  expect(back).not.toHaveBeenCalled()
  await user.keyboard("{Escape}")
  expect(back).toHaveBeenCalledOnce()
})

it("searches shortcuts, recovers from no results, and starts fresh when reopened", async () => {
  const user = userEvent.setup()
  render(<ReviewShortcutsDialog />)
  const trigger = screen.getByRole("button", { name: "Keyboard shortcuts ?" })
  await user.click(trigger)
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" })
  const search = within(dialog).getByRole("textbox", { name: "Search keyboard shortcuts" })

  await user.type(search, "checkout")
  expect(within(dialog).getByText("CLI checkout command")).toBeTruthy()
  expect(within(dialog).queryByText("Back to PRs")).toBeNull()
  await user.type(search, "-none")
  expect(within(dialog).getByText("No matching shortcuts")).toBeTruthy()
  await user.click(within(dialog).getByRole("button", { name: "Clear search" }))
  expect(document.activeElement).toBe(search)
  expect(within(dialog).getByText("PR link")).toBeTruthy()

  await user.type(search, "copy")
  await user.keyboard("{Escape}")
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  await user.click(trigger)
  expect(await screen.findByRole("textbox", { name: "Search keyboard shortcuts" })).toHaveProperty(
    "value",
    "",
  )
  expect(within(screen.getByRole("dialog")).getByText("PR link")).toBeTruthy()
})

it("opens without Shift and leaves typing and other dialogs alone", () => {
  const { container } = render(
    <>
      <ReviewShortcutsDialog />
      <textarea />
      <dialog open aria-label="Another dialog">
        <button>Another action</button>
      </dialog>
    </>,
  )

  for (const target of container.querySelectorAll("textarea, dialog button")) {
    fireEvent.keyDown(target, { key: "?", shiftKey: true })
  }

  expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull()
  fireEvent.keyDown(window, { key: "?" })
  expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy()
})

it.each(["MacIntel", "Win32"])("shows platform keys on %s", async (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)
  const user = userEvent.setup()
  render(<ReviewShortcutsDialog />)
  await user.click(screen.getByRole("button", { name: "Keyboard shortcuts ?" }))
  const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" })
  expect(within(dialog).getAllByText(platform === "MacIntel" ? "⌘" : "Ctrl")).not.toHaveLength(0)
  expect(within(dialog).queryAllByText(platform === "MacIntel" ? "Ctrl" : "⌘")).toHaveLength(0)
})
