import {
  PageElement,
  type PageEvent,
  type PagePart,
  type PageState,
  PageText,
} from "@glass/contracts"
import { type HTMLElement as HappyElement, Window } from "happy-dom"
import { expect, it } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { pageNotes } from "./pageNotes"

const page = `<!doctype html>
<html><body>
  <h1>Rate-limit the poller</h1>
  <section id="limits">
    <h2>Limits</h2>
    <p>Each Connection gets a burst of 20 and a refill of <b>five</b> per minute.</p>
  </section>
  <table>
    <thead><tr><th>Option</th><th>Refill / min</th></tr></thead>
    <tbody><tr><td>Token bucket</td><td>5</td></tr></tbody>
  </table>
  <button id="own">Own button</button>
</body></html>`

const limits: PagePart = PageText.make({
  selector: "#limits > p",
  heading: "Limits",
  excerpt: "five per minute",
})

const openPage = () => {
  const window = new Window()
  const events: Array<PageEvent> = []

  const box = new window.DOMRect(10, 10, 80, 16)
  Object.defineProperty(window.Range.prototype, "getClientRects", { value: () => [box] })
  Object.defineProperty(window.Range.prototype, "getBoundingClientRect", { value: () => box })
  window.document.write(page)

  let receive: ((state: PageState) => void) | null = null

  pageNotes(
    // SAFETY: happy-dom's Window implements the DOM the script uses.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- See SAFETY above.
    window as unknown as typeof globalThis,
    { post: (event) => void events.push(event), onState: (next) => (receive = next) },
  )

  const { document } = window

  const overlay = () => {
    const root = document.querySelector("glass-page-notes")?.shadowRoot

    if (root == null) throw new Error("The page notes overlay is missing")

    return root
  }

  return {
    window,
    document,
    overlay,
    parts: () => events.flatMap((event) => (event.type === "part" ? [event.part] : [])),
    last: () => events.at(-1),
    send: (state: PageState) => receive?.(state),
  }
}

it("turns selected text into a part named by its paragraph, heading, and the words chosen", async () => {
  const { window, document, overlay, parts } = openPage()
  const paragraph = document.querySelector("#limits p")!
  const range = document.createRange()
  range.setStart(paragraph.firstChild!, "Each Connection gets a burst of 20 and a ".length)
  range.setEnd(paragraph.querySelector("b")!.firstChild!, 4)
  window.getSelection().addRange(range)

  const add = await eventually(() => {
    const button = overlay().querySelector("button")
    expect(button?.textContent).toBe("Add Feedback note")

    return button!
  })

  add.click()

  await eventually(() =>
    expect(parts()).toEqual<Array<PagePart>>([
      PageText.make({
        selector: "#limits > p",
        heading: "Limits",
        excerpt: "refill of five",
      }),
    ]),
  )
})

it("picks the clicked element while Pick element is on, keeping the click from the page", async () => {
  const { document, parts, send } = openPage()
  let ownClicks = 0
  document.querySelector("#own")!.addEventListener("click", () => ownClicks++)
  send({ pick: true, notes: [], active: null })
  await eventually(() => expect(document.head.textContent).toContain("crosshair"))

  document.querySelector<HappyElement>("tbody td:nth-of-type(2)")!.click()
  document.querySelector<HappyElement>("#own")!.click()

  await eventually(() =>
    expect(parts()).toEqual<Array<PagePart>>([
      PageElement.make({
        label: "Table cell · Token bucket × Refill / min",
        selector: "body > table > tbody > tr > td:nth-of-type(2)",
        heading: "Limits",
        excerpt: "5",
      }),
    ]),
  )
  expect(ownClicks).toBe(0)
})

it("pins each note it finds on the page, numbered in the order they were left", async () => {
  const { overlay, last, send } = openPage()
  send({
    pick: false,
    active: null,
    notes: [
      { id: "gone", part: { ...limits, excerpt: "ten per minute" } },
      { id: "found", part: limits },
    ],
  })

  const pins = await eventually(() => {
    const shown = [...overlay().querySelectorAll("button")]
    expect(shown.map((pin) => pin.textContent)).toEqual(["2"])

    return shown
  })

  pins[0]!.click()

  await eventually(() => expect(last()).toMatchObject({ type: "open", id: "found" }))
})

it("keeps highlighting a pick when a notes change crosses it on the way to the renderer", async () => {
  const { document, overlay, last, send } = openPage()
  const notes = [{ id: "saved", part: limits }]
  send({ pick: true, notes: [], active: null })
  await eventually(() => expect(document.head.textContent).toContain("crosshair"))

  document.querySelector<HappyElement>("tbody td:nth-of-type(2)")!.click()
  send({ pick: true, notes, active: null })
  send({ pick: true, notes, active: { type: "draft" } })

  await eventually(() => {
    expect(overlay().querySelector(".element.draft")).not.toBeNull()
    expect(last()).toMatchObject({ type: "rect" })
  })
})
