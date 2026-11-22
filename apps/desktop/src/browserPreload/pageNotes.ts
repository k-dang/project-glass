import type { PageEvent, PagePart, PageRect, PageState } from "@glass/contracts"

const accent = "oklch(0.58 0.19 262)"

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

const trunc = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

const quoted = (text: string) => (text === "" ? "" : ` “${trunc(text, 40)}”`)

const rectOf = (anchor: Range | Element): PageRect => {
  const { top, left, bottom, right } = anchor.getBoundingClientRect()

  return { top, left, bottom, right }
}

interface PageChannel {
  readonly post: (event: PageEvent) => void
  readonly onState: (receive: (state: PageState) => void) => void
}

// WARNING: This runs in every page of a Browser pane, so it builds PageParts by hand rather than load Effect into each one.
export function pageNotes(window: typeof globalThis, { post, onState }: PageChannel): void {
  const {
    document,
    CSS,
    Element,
    Node,
    NodeFilter,
    Range,
    Text,
    MutationObserver,
    ResizeObserver,
  } = window

  const getComputedStyle = (element: Element) => window.getComputedStyle(element)

  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    window.requestAnimationFrame(callback)

  let state: PageState = { pick: false, notes: [], active: null }
  let draft: Range | Element | null = null
  let hover: Element | null = null
  let hoverLabel = ""
  let selected: Range | null = null
  let anchors = new Map<string, Range | Element | null>()
  let scheduled = false

  const host = document.createElement("glass-page-notes")
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647"
  const root = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = `
    * { box-sizing: border-box; }
    .mark { position: absolute; }
    .text { background: oklch(0.58 0.19 262 / 0.18); border-bottom: 2px solid ${accent}; }
    .element { border: 2px solid ${accent}; border-radius: 4px; }
    .draft { border-style: dashed; }
    .hover { border: 1.5px dashed ${accent}; border-radius: 4px; background: oklch(0.58 0.19 262 / 0.06); }
    .label, .pin, .add { font: 500 12px/1.4 system-ui, sans-serif; }
    .label { transform: translateY(-100%); margin-top: -3px; padding: 1px 6px; border-radius: 4px;
      background: ${accent}; color: white; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
    .pin { width: 20px; height: 20px; padding: 0; border-radius: 999px; border: 2px solid white; background: ${accent};
      color: white; font-size: 11px; font-weight: 600; line-height: 16px; text-align: center; cursor: pointer;
      pointer-events: auto; box-shadow: 0 1px 3px rgb(0 0 0 / 0.3); }
    .add { padding: 5px 10px; border-radius: 6px; border: 1px solid rgb(0 0 0 / 0.15); background: white; color: #111;
      cursor: pointer; pointer-events: auto; box-shadow: 0 4px 14px -4px rgb(0 0 0 / 0.35); }
  `
  const layer = document.createElement("div")
  root.append(style, layer)
  document.documentElement.append(host)

  const picking = document.createElement("style")
  picking.textContent = "* { cursor: crosshair !important; user-select: none !important; }"

  const ours = (node: Node | null) => node !== null && (node === host || host.contains(node))

  const blockOf = (node: Node) => {
    let element = node instanceof Element ? node : node.parentElement

    while (
      element !== null &&
      element.parentElement !== null &&
      element !== document.body &&
      getComputedStyle(element).display === "inline"
    )
      element = element.parentElement

    return element ?? document.body
  }

  const selectorOf = (element: Element) => {
    const steps: Array<string> = []

    for (
      let at: Element | null = element;
      at !== null && at !== document.documentElement;
      at = at.parentElement
    ) {
      if (at.id !== "" && document.querySelectorAll(`#${CSS.escape(at.id)}`).length === 1) {
        steps.unshift(`#${CSS.escape(at.id)}`)
        break
      }

      const name = at.localName
      const siblings = at.parentElement === null ? [at] : [...at.parentElement.children]
      const same = siblings.filter((sibling) => sibling.localName === name)

      steps.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(at) + 1})` : name)
    }

    return steps.join(" > ")
  }

  const headingOf = (element: Element) => {
    let found: Element | null = null

    for (const heading of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      const before =
        heading === element ||
        heading.contains(element) ||
        (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

      if (!before) break

      found = heading
    }

    return found === null ? null : trunc(squash(found.textContent ?? ""), 120)
  }

  const names = new Map([
    ["p", "Paragraph"],
    ["li", "List item"],
    ["ul", "List"],
    ["ol", "List"],
    ["img", "Image"],
    ["a", "Link"],
    ["button", "Button"],
    ["table", "Table"],
    ["tr", "Table row"],
    ["figure", "Figure"],
    ["figcaption", "Caption"],
    ["blockquote", "Quote"],
    ["pre", "Code block"],
    ["code", "Code"],
    ["svg", "Diagram"],
    ["g", "Diagram part"],
    ["canvas", "Canvas"],
    ["input", "Field"],
    ["select", "Field"],
    ["textarea", "Field"],
    ["label", "Label"],
    ["section", "Section"],
    ["article", "Section"],
    ["nav", "Navigation"],
    ["header", "Header"],
    ["footer", "Footer"],
    ["div", "Box"],
    ["span", "Box"],
  ])

  const describe = (element: Element) => {
    const text = squash(element.textContent ?? "")
    const name = element.localName

    if (name === "td" || name === "th") {
      const cells = [...(element.parentElement?.children ?? [])]
      const index = cells.indexOf(element)
      const row = squash(cells[0]?.textContent ?? "")
      const head = element.closest("table")?.querySelector("thead tr")?.children[index]
      const column = squash(head?.textContent ?? "")

      return index > 0 && row !== "" && column !== ""
        ? `Table cell · ${trunc(row, 30)} × ${trunc(column, 30)}`
        : `Table cell${quoted(text)}`
    }

    if (/^h[1-6]$/.test(name)) return `Heading${quoted(text)}`

    if (name === "section" || name === "article") {
      const heading = element.querySelector("h1, h2, h3, h4, h5, h6")

      return `Section${quoted(squash(heading?.textContent ?? ""))}`
    }

    const named =
      element.getAttribute("aria-label") ??
      element.getAttribute("alt") ??
      element.getAttribute("title")

    return `${names.get(name) ?? `<${name}>`}${quoted(squash(named ?? text))}`
  }

  const pickable = (target: EventTarget | null) => {
    if (!(target instanceof Element) || ours(target)) return null

    if (target === document.documentElement || target === document.body) return null

    const svg = target.closest("svg")

    if (svg !== null) return target.closest("svg g[id], svg g.node") ?? svg

    let element = target

    while (
      element.parentElement !== null &&
      element.parentElement !== document.body &&
      !element.matches("a, button, img, code, input, select, textarea, label") &&
      getComputedStyle(element).display === "inline"
    )
      element = element.parentElement

    return element
  }

  const textIn = (scope: Element, excerpt: string) => {
    const target = squash(excerpt)

    if (target === "") return null

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        ours(node) || node.parentElement?.closest("script, style, noscript, template") != null
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    })

    let flat = ""
    const at: Array<readonly [Text, number]> = []
    let spaced = true

    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
      if (!(text instanceof Text)) continue

      for (let index = 0; index < text.data.length; index++) {
        const space = /\s/.test(text.data[index] ?? "")

        if (space && spaced) continue

        flat += space ? " " : text.data[index]
        at.push([text, index])
        spaced = space
      }
    }

    const found = flat.indexOf(target)
    const first = at[found]
    const last = at[found + target.length - 1]

    if (found < 0 || first === undefined || last === undefined) return null

    const range = document.createRange()
    range.setStart(first[0], first[1])
    range.setEnd(last[0], last[1] + 1)

    return range
  }

  const queryOf = (selector: string) => {
    try {
      return document.querySelector(selector)
    } catch {
      return null
    }
  }

  const locate = (part: PagePart): Range | Element | null => {
    const scope = queryOf(part.selector)

    if (part._tag === "PageElement") return scope

    return (
      (scope === null ? null : textIn(scope, part.excerpt)) ?? textIn(document.body, part.excerpt)
    )
  }

  const anchorOf = (id: string, part: PagePart) => {
    if (!anchors.has(id)) anchors.set(id, locate(part))

    return anchors.get(id) ?? null
  }

  const forgetMissing = () => {
    for (const [id, anchor] of anchors) if (anchor === null) anchors.delete(id)

    schedule()
  }

  const boxesOf = (anchor: Range | Element) =>
    anchor instanceof Range
      ? [...anchor.getClientRects()].filter((rect) => rect.width > 1)
      : [anchor.getBoundingClientRect()]

  const add = (tag: string, className: string, rect: { top: number; left: number }) => {
    const element = document.createElement(tag)
    element.className = className
    element.style.top = `${rect.top}px`
    element.style.left = `${rect.left}px`
    layer.append(element)

    return element
  }

  const box = (className: string, rect: DOMRect, pad: number) => {
    const element = add("div", `mark ${className}`, { top: rect.top - pad, left: rect.left - pad })
    element.style.width = `${rect.width + pad * 2}px`
    element.style.height = `${rect.height + pad * 2}px`
  }

  const paintPin = (id: string, number: number, corner: DOMRect, anchor: Range | Element) => {
    const pin = add("button", "mark pin", { top: corner.top - 12, left: corner.right - 10 })
    pin.textContent = String(number)
    pin.setAttribute("aria-label", `Feedback note ${number}`)
    pin.addEventListener("click", () => post({ type: "open", id, rect: rectOf(anchor) }))
  }

  const paintAddButton = (selection: DOMRect) => {
    const button = add("button", "mark add", {
      top: Math.min(selection.bottom + 6, window.innerHeight - 34),
      left: Math.max(6, Math.min(selection.right - 130, window.innerWidth - 150)),
    })

    button.textContent = "Add Feedback note"
    button.addEventListener("mousedown", (event) => event.preventDefault())
    button.addEventListener("click", () => {
      if (selected !== null) chooseText(selected)
    })
  }

  const activeAnchor = () => {
    if (state.active?.type === "draft") return draft

    if (state.active?.type === "note") return anchors.get(state.active.id) ?? null

    return null
  }

  const draw = () => {
    scheduled = false

    const marks: Array<{ readonly className: string; readonly rect: DOMRect }> = []

    const pins: Array<{
      readonly id: string
      readonly number: number
      readonly corner: DOMRect
      readonly anchor: Range | Element
    }> = []

    const measure = (anchor: Range | Element, isDraft: boolean) => {
      const boxes = boxesOf(anchor)
      const kind = anchor instanceof Range ? "text" : "element"

      for (const rect of boxes) marks.push({ className: `${kind}${isDraft ? " draft" : ""}`, rect })

      return anchor instanceof Range ? boxes.at(-1) : boxes[0]
    }

    state.notes.forEach(({ id, part }, index) => {
      const anchor = anchorOf(id, part)
      const isActive = state.active?.type === "note" && state.active.id === id
      const corner = anchor === null ? undefined : measure(anchor, isActive)

      if (anchor !== null && corner !== undefined)
        pins.push({ id, number: index + 1, corner, anchor })
    })

    if (state.active?.type === "draft" && draft !== null) measure(draft, true)

    const hovered =
      state.pick && state.active === null && hover !== null ? hover.getBoundingClientRect() : null

    const selection =
      !state.pick && state.active === null && selected !== null
        ? (boxesOf(selected).at(-1) ?? selected.getBoundingClientRect())
        : null

    const active = activeAnchor()
    const activeRect = active === null ? null : rectOf(active)

    layer.replaceChildren()

    for (const { className, rect } of marks)
      box(className, rect, className.startsWith("text") ? 0 : 3)

    for (const { id, number, corner, anchor } of pins) paintPin(id, number, corner, anchor)

    if (hovered !== null) {
      box("hover", hovered, 3)
      add("div", "mark label", { top: hovered.top - 3, left: hovered.left - 3 }).textContent =
        hoverLabel
    }

    if (selection !== null) paintAddButton(selection)

    if (activeRect !== null) post({ type: "rect", rect: activeRect })
  }

  const nothingToDraw = () =>
    state.notes.length === 0 &&
    !state.pick &&
    state.active === null &&
    selected === null &&
    layer.childElementCount === 0

  const schedule = () => {
    if (scheduled || nothingToDraw()) return

    scheduled = true
    requestAnimationFrame(draw)
  }

  const choose = (anchor: Range | Element, part: PagePart) => {
    draft = anchor
    selected = null
    hover = null
    state = { ...state, active: { type: "draft" } }
    post({ type: "part", part, rect: rectOf(anchor) })
    schedule()
  }

  const chooseText = (range: Range) => {
    const excerpt = squash(range.toString())
    const block = blockOf(range.startContainer)
    const kept = range.cloneRange()

    window.getSelection()?.removeAllRanges()
    choose(kept, {
      _tag: "PageText",
      selector: selectorOf(block),
      heading: headingOf(block),
      excerpt,
    })
  }

  const chooseElement = (element: Element) =>
    choose(element, {
      _tag: "PageElement",
      label: describe(element),
      selector: selectorOf(element),
      heading: headingOf(element),
      excerpt: trunc(squash(element.textContent ?? ""), 500),
    })

  const blocked = [
    "mousedown",
    "pointerdown",
    "mouseup",
    "pointerup",
    "dblclick",
    "auxclick",
    "contextmenu",
  ]

  for (const type of [...blocked, "click"])
    window.addEventListener(
      type,
      (event) => {
        if (!state.pick || event.composedPath().includes(host)) return

        event.preventDefault()
        event.stopImmediatePropagation()

        if (type !== "click" || state.active !== null) return

        const element = pickable(event.target)

        if (element !== null) chooseElement(element)
      },
      true,
    )

  window.addEventListener(
    "mousemove",
    (event) => {
      if (!state.pick || state.active !== null) return

      const element = pickable(event.target)

      if (element === hover) return

      hover = element
      hoverLabel = element === null ? "" : describe(element)
      schedule()
    },
    true,
  )

  document.addEventListener("mouseleave", () => {
    hover = null
    schedule()
  })

  document.addEventListener("selectionchange", () => {
    const selection = window.getSelection()
    const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

    selected =
      range === null ||
      range.collapsed ||
      ours(range.commonAncestorContainer) ||
      squash(range.toString()) === ""
        ? null
        : range.cloneRange()

    schedule()
  })

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") post({ type: "escape" })
    },
    true,
  )

  window.addEventListener("scroll", schedule, { capture: true, passive: true })
  window.addEventListener("resize", schedule)
  new ResizeObserver(schedule).observe(document.documentElement)
  new MutationObserver(forgetMissing).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  })

  onState((next) => {
    anchors = new Map([...anchors].filter(([id]) => next.notes.some((note) => note.id === id)))

    if (next.active === null) draft = null

    if (!next.pick) hover = null

    if (next.pick && !state.pick) {
      window.getSelection()?.removeAllRanges()
      document.head.append(picking)
    }

    if (!next.pick) picking.remove()

    state = next
    schedule()
  })

  post({ type: "ready" })
}
