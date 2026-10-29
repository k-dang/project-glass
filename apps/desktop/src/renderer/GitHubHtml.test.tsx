// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { GitHubHtml } from "./GitHubHtml"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const gallery = `
  <table><tr>
    <td><a href="https://github.com/user-attachments/assets/before"><img src="https://github.com/thumbnail.png" alt="Before"></a></td>
    <td><img src="https://github.com/after.png" alt="After"></td>
  </tr></table>
`

it("opens linked and bare images as one gallery, keeps comments separate, and returns focus on Escape", async () => {
  render(
    <>
      <GitHubHtml html={gallery} />
      <GitHubHtml html='<img src="https://github.com/comment.png" alt="Comment" />' />
    </>,
  )
  const user = userEvent.setup()
  const opener = screen.getByRole("button", { name: "Preview Before" })
  opener.focus()
  await user.keyboard("{Enter}")

  let dialog = await screen.findByRole("dialog", { name: "Before" })
  expect(within(dialog).getByRole<HTMLImageElement>("img").src).toBe(
    "https://github.com/user-attachments/assets/before",
  )
  expect(within(dialog).getByText("1 / 2")).toBeTruthy()
  await user.keyboard("{ArrowRight}")
  dialog = screen.getByRole("dialog", { name: "After" })
  expect(within(dialog).getByText("2 / 2")).toBeTruthy()
  await user.click(within(dialog).getByRole("button", { name: "Next image" }))
  expect(screen.getByRole("dialog", { name: "Before" })).toBeTruthy()
  await user.keyboard("{Escape}")
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(opener))

  await user.click(screen.getByRole("button", { name: "Preview After" }))
  expect(await screen.findByRole("dialog", { name: "After" })).toBeTruthy()
  await user.click(screen.getByRole("button", { name: "Close" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
})

it("zooms with controls, keyboard and wheel; pans instead of changing images when zoomed", async () => {
  render(<GitHubHtml html={gallery} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Preview Before" }))
  const dialog = await screen.findByRole("dialog")
  const image = within(dialog).getByRole<HTMLImageElement>("img")
  const viewport = within(dialog).getByRole("button", { name: "Before, zoomable image" })
  Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } })
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600))
  fireEvent.load(image)

  await user.click(within(dialog).getByRole("button", { name: "Zoom in" }))
  expect(image.style.width).toBe("1200px")
  expect(viewport.getAttribute("aria-pressed")).toBe("true")
  await user.keyboard("0")
  expect(image.style.width).toBe("800px")
  await user.keyboard("+")
  expect(image.style.width).toBe("1200px")
  viewport.focus()
  await user.keyboard("+")
  expect(image.style.width).toBe("1800px")
  Object.defineProperties(viewport, { scrollWidth: { value: 1800 }, clientWidth: { value: 800 } })
  const left = viewport.scrollLeft
  await user.keyboard("{ArrowRight}")
  expect(viewport.scrollLeft).toBe(left + 40)
  expect(screen.getByRole("dialog", { name: "Before" })).toBeTruthy()

  await user.keyboard("0")
  expect(image.style.width).toBe("800px")
  await user.keyboard("{Enter}")
  expect(image.style.width).toBe("1600px")
  await user.keyboard(" ")
  expect(image.style.width).toBe("800px")
  const wheel = new WheelEvent("wheel", { deltaY: -100, cancelable: true })
  act(() => {
    viewport.dispatchEvent(wheel)
  })
  expect(wheel.defaultPrevented).toBe(true)
  expect(parseFloat(image.style.width)).toBeGreaterThan(800)
  await user.click(within(dialog).getByRole("button", { name: "Fit" }))
  expect(image.style.width).toBe("800px")
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Zoom out" }).disabled).toBe(
    true,
  )
})

it("keeps website links and modifier clicks, while rejecting authored preview markers", async () => {
  const { container } = render(
    <GitHubHtml
      html={`
    <a href="https://example.com"><img src="https://github.com/badge.png" alt="Build status"></a>
    <a href="https://example.com/docs">Documentation</a>
    <a href="https://github.com/org/repo/blob/main/diagram.svg"><img src="https://github.com/diagram.svg" alt="Source file"></a>
    <a href="https://github.com/org/repo/tree/main/images.png"><img src="https://github.com/folder.png" alt="Source directory"></a>
    <a href="http://"><img src="https://github.com/photo.png" alt="Malformed destination"></a>
    <p data-image-preview="0">Spoofed preview</p>
    <img src="https://github.com/photo.png" alt="Photo">
  `}
    />,
  )

  const user = userEvent.setup()
  const badge = screen.getByRole("link", { name: "Build status" })
  const docs = screen.getByRole("link", { name: "Documentation" })
  const source = screen.getByRole("link", { name: "Source file" })
  const directory = screen.getByRole("link", { name: "Source directory" })
  expect(screen.getByRole("link", { name: "Malformed destination" })).toBeTruthy()
  const clicks: boolean[] = []
  container.addEventListener("click", (event) => {
    clicks.push(event.defaultPrevented)
    event.preventDefault()
  })
  await user.click(badge)
  await user.click(docs)
  await user.click(source)
  await user.click(directory)
  await user.keyboard("{Control>}")
  await user.click(screen.getByRole("button", { name: "Preview Photo" }))
  await user.keyboard("{/Control}")
  expect(clicks).toEqual([false, false, false, false, false])
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.getByText("Spoofed preview").hasAttribute("data-image-preview")).toBe(false)
})

it("keeps zoom shortcuts active when gallery and close controls have focus", async () => {
  render(<GitHubHtml html={gallery} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Preview Before" }))
  const dialog = await screen.findByRole("dialog")
  const image = within(dialog).getByRole<HTMLImageElement>("img")
  Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } })
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600))
  fireEvent.load(image)

  for (const name of ["Next image", "Previous image", "Close"]) {
    const control = within(dialog).getByRole("button", { name })
    control.focus()
    await user.keyboard("+")
    expect(image.style.width).toBe("1200px")
    await user.keyboard("-")
    expect(image.style.width).toBe("800px")
    await user.keyboard("+0")
    expect(image.style.width).toBe("800px")
    expect(document.activeElement).toBe(control)
  }
})

it("keeps focus on a gallery control when activating it repeatedly", async () => {
  render(<GitHubHtml html={gallery} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Preview Before" }))
  const dialog = await screen.findByRole("dialog")
  const next = within(dialog).getByRole("button", { name: "Next image" })
  next.focus()
  await user.keyboard("{Enter}")
  expect(screen.getByRole("dialog", { name: "After" })).toBeTruthy()
  expect(document.activeElement).toBe(next)
  await user.keyboard("{Enter}")
  expect(screen.getByRole("dialog", { name: "Before" })).toBeTruthy()
  expect(document.activeElement).toBe(next)
})

it("shows image failures without trapping the gallery and closes stale previews when HTML changes", async () => {
  const view = render(<GitHubHtml html={gallery} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Preview Before" }))
  const dialog = await screen.findByRole("dialog")
  fireEvent.error(within(dialog).getByRole("img"))
  expect(within(dialog).getByRole("alert").textContent).toBe("This image could not be loaded.")
  expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Zoom in" }).disabled).toBe(
    true,
  )
  await user.click(within(dialog).getByRole("button", { name: "Next image" }))
  expect(screen.getByRole("dialog", { name: "After" })).toBeTruthy()
  view.rerender(<GitHubHtml html="<p>Updated description</p>" />)
  expect(screen.queryByRole("dialog")).toBeNull()
})
