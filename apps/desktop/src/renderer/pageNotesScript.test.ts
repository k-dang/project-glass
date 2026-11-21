import { PageElement, type PagePart, PageText } from "@glass/contracts"
import { Option, Schema } from "effect"
import { type HTMLElement as HappyElement, Window } from "happy-dom"
import { expect, it } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { FromPage, type PageEvent, type PageState } from "./pageMessages"
import { withPageNotes } from "./pageNotesScript"

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

const fromPage = Schema.decodeUnknownOption(FromPage)

const limits: PagePart = PageText.make({
  selector: "#limits > p",
  heading: "Limits",
  excerpt: "five per minute",
})

const openPage = () => {
  const window = new Window({ settings: { enableJavaScriptEvaluation: true } })
  const events: Array<PageEvent> = []

  window.addEventListener("message", (message) => {
    if (!(message instanceof window.MessageEvent)) return

    const received = fromPage(message.data)

    if (Option.isSome(received)) events.push(received.value.glassPageEvent)
  })
  const box = new window.DOMRect(10, 10, 80, 16)
  Object.defineProperty(window.Range.prototype, "getClientRects", { value: () => [box] })
  Object.defineProperty(window.Range.prototype, "getBoundingClientRect", { value: () => box })
  window.document.write(withPageNotes(page))

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
    send: (state: PageState) => window.postMessage({ glassPageState: state }, "*"),
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
