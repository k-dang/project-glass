// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { useReviewShortcuts } from "./useReviewShortcuts"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Shortcuts(props: { run: () => void; allow?: boolean }) {
  useReviewShortcuts([
    {
      key: "j",
      run: props.run,
      allowInEditable: props.allow ?? false,
      allowInDialog: props.allow ?? false,
    },
  ])

  return null
}

it("uses current actions and removes shortcuts on unmount", () => {
  const first = vi.fn<() => void>()
  const next = vi.fn<() => void>()
  const view = render(<Shortcuts run={first} />)
  expect(fireEvent.keyDown(window, { key: "j" })).toBe(false)
  expect(first).toHaveBeenCalledTimes(1)
  view.rerender(<Shortcuts run={next} />)
  fireEvent.keyDown(window, { key: "j" })
  expect(next).toHaveBeenCalledTimes(1)
  view.unmount()
  fireEvent.keyDown(window, { key: "j" })
  expect(next).toHaveBeenCalledTimes(1)
})

it("leaves typing, dialogs, composing, repeats, modifiers and consumed events alone", () => {
  const run = vi.fn<() => void>()

  const view = render(
    <>
      <Shortcuts run={run} />
      <input />
      <textarea />
      <select aria-label="Choice" />
      <div contentEditable suppressContentEditableWarning>
        <span>Editing</span>
      </div>
      <dialog open>
        <button>Dialog</button>
      </dialog>
      <div role="alertdialog">
        <button>Alert</button>
      </div>
    </>,
  )

  for (const target of view.container.querySelectorAll("input, textarea, select, span, button")) {
    expect(fireEvent.keyDown(target, { key: "j" })).toBe(true)
  }

  for (const extra of [
    { isComposing: true },
    { repeat: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
  ]) {
    fireEvent.keyDown(window, { key: "j", ...extra })
  }

  const consumed = new KeyboardEvent("keydown", { key: "j", cancelable: true })
  consumed.preventDefault()
  window.dispatchEvent(consumed)
  expect(run).not.toHaveBeenCalled()
})

it("allows explicit shortcuts while editing inside a dialog", () => {
  const run = vi.fn<() => void>()

  const view = render(
    <>
      <Shortcuts run={run} allow />
      <dialog open>
        <textarea />
      </dialog>
    </>,
  )

  fireEvent.keyDown(view.container.querySelector("textarea")!, { key: "j" })
  expect(run).toHaveBeenCalledTimes(1)
})

it("recognizes editable fields and dialogs when a browser retargets a shadow DOM event", () => {
  const run = vi.fn<() => void>()

  const view = render(
    <>
      <Shortcuts run={run} />
      <div data-testid="shadow-host" />
    </>,
  )

  const host = view.getByTestId("shadow-host")
  const shadow = host.attachShadow({ mode: "open" })

  for (const content of ["<input />", '<div role="dialog" tabindex="-1"></div>']) {
    shadow.innerHTML = content
    const origin = shadow.firstElementChild!

    const event = new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      composed: true,
      cancelable: true,
    })

    // Happy DOM does not retarget shadow events; model the path Chromium exposes
    // when its window listener receives an event whose target is the host.
    vi.spyOn(event, "composedPath").mockReturnValue([
      origin,
      shadow,
      host,
      document.body,
      document,
      window,
    ])
    host.dispatchEvent(event)
    expect(event.target).toBe(host)
    expect(event.defaultPrevented).toBe(false)
  }

  expect(run).not.toHaveBeenCalled()
})
