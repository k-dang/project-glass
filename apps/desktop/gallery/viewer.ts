import type { Shot } from "./shot.ts"

type Scheme = "light" | "dark"

const schemeChoices = ["light", "dark", "both"] as const

type SchemeChoice = (typeof schemeChoices)[number]

const viewChoices = ["single", "grid", "canvas"] as const

type View = (typeof viewChoices)[number]

const element = <T extends Element>(id: string, kind: abstract new () => T) => {
  const found = document.getElementById(id)

  if (!(found instanceof kind)) throw new Error(`The gallery page has no #${id}`)

  return found
}

const figureAt = (target: EventTarget | null) =>
  target instanceof Element ? target.closest("figure") : null

const shotsJson = element("shots", HTMLScriptElement).textContent

const shots: ReadonlyArray<Shot> = JSON.parse(shotsJson)

const list = element("list", HTMLElement)

const stage = element("stage", HTMLElement)

const filter = element("filter", HTMLInputElement)

const title = element("title", HTMLElement)

const canvas = element("canvas", HTMLElement)

const world = element("world", HTMLElement)

const zoomLevel = element("zoom-level", HTMLOutputElement)

let scheme: SchemeChoice = "light"

let view: View = "single"

let current = 0

const visible = () => {
  const query = filter.value.toLowerCase()

  return shots.filter((shot) => `${shot.area} ${shot.name}`.toLowerCase().includes(query))
}

const src = (shot: Shot, shown: Scheme, size = "") => `shots/${shot.id}-${shown}${size}.png`

const alt = (shot: Shot, shown: Scheme) => `${shot.area}: ${shot.name} (${shown})`

const schemesShown = (): ReadonlyArray<Scheme> => (scheme === "both" ? ["light", "dark"] : [scheme])

const gridFigure = (shot: Shot, shown: Scheme) =>
  `<figure data-id="${shot.id}"><img loading="lazy" src="${src(shot, shown, "-thumb")}" alt="${alt(shot, shown)}"><figcaption>${shot.area} · ${shot.name}</figcaption></figure>`

// A new <img> paints blank until its PNG decodes, which flashes on every step. Decode the next shot
// off-screen, then swap it in whole, so the old one stays until the new one is ready.
const decoded = new Map<string, Promise<HTMLImageElement>>()

const decode = (url: string) => {
  const cached = decoded.get(url)

  if (cached !== undefined) return cached

  const img = new Image()
  img.src = url

  const ready = img.decode().then(
    () => img,
    () => img,
  )

  decoded.set(url, ready)

  return ready
}

let showing = 0

const showStage = (shot: Shot) => {
  const schemes = schemesShown()
  const token = ++showing

  void Promise.all(schemes.map((shown) => decode(src(shot, shown)))).then((images) => {
    if (token !== showing) return

    stage.className = schemes.length > 1 ? "both" : ""
    stage.replaceChildren(
      ...images.map((img, index) => {
        const shown = schemes[index] ?? "light"
        img.alt = alt(shot, shown)
        const figure = document.createElement("figure")
        figure.append(img)

        if (schemes.length > 1) {
          const caption = document.createElement("figcaption")
          caption.textContent = shown === "light" ? "Light" : "Dark"
          figure.append(caption)
        }

        return figure
      }),
    )
    stage.scrollTop = 0
  })

  const shown = visible()
  const index = shown.indexOf(shot)

  const kept = [shot, shown[index + 1], shown[index - 1]].flatMap((near) =>
    near === undefined ? [] : schemes.map((nearScheme) => src(near, nearScheme)),
  )

  for (const url of decoded.keys()) if (!kept.includes(url)) decoded.delete(url)

  for (const url of kept) void decode(url)
}

const camera = { x: 0, y: 0, z: 1 }

let builtFor: string | null = null

let settle = 0

let detail: "thumb" | "full" | null = null

// Zoomed out, every shot is on screen at once and Chromium can't keep them all decoded at full
// size, so show the 320px thumbnails until a shot would be drawn wider than they are.
const showDetail = () => {
  const next = camera.z * devicePixelRatio <= 0.25 ? "thumb" : "full"

  if (next === detail) return

  detail = next

  for (const img of world.querySelectorAll("img")) img.src = img.dataset[next] ?? ""
}

const applyCamera = () => {
  world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`
  let dots = 32 * camera.z

  while (dots < 16) dots *= 2
  canvas.style.backgroundSize = `${dots}px ${dots}px`
  canvas.style.backgroundPosition = `${camera.x}px ${camera.y}px`
  zoomLevel.textContent = `${Math.round(camera.z * 100)}%`
  showDetail()
  // Promote #world to its own layer only while it moves, so it re-rasterizes sharp once it stops.
  world.classList.add("moving")
  clearTimeout(settle)
  settle = window.setTimeout(() => world.classList.remove("moving"), 150)
}

const zoomAt = (x: number, y: number, z: number) => {
  const next = Math.min(2, Math.max(0.02, z))
  camera.x = x - ((x - camera.x) / camera.z) * next
  camera.y = y - ((y - camera.y) / camera.z) * next
  camera.z = next
  applyCamera()
}

const zoomCenter = (factor: number) =>
  zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, camera.z * factor)

const fit = () => {
  const width = world.offsetWidth
  const height = world.offsetHeight
  camera.z = Math.min(canvas.clientWidth / width, canvas.clientHeight / height)
  camera.x = (canvas.clientWidth - width * camera.z) / 2
  camera.y = (canvas.clientHeight - height * camera.z) / 2
  applyCamera()
}

const laneFigure = (shot: Shot) =>
  `<figure data-id="${shot.id}"><div class="pair">${schemesShown()
    .map(
      (shown) =>
        `<img decoding="async" draggable="false" width="${shot.width}" height="${shot.height}" data-full="${src(shot, shown)}" data-thumb="${src(shot, shown, "-thumb")}" alt="${alt(shot, shown)}">`,
    )
    .join("")}</div><figcaption>${shot.name}</figcaption></figure>`

const buildWorld = (shown: ReadonlyArray<Shot>) => {
  const key = `${scheme}|${shown.map((shot) => shot.id).join()}`
  const first = builtFor === null

  if (builtFor !== key) {
    builtFor = key
    const lanes = Map.groupBy(shown, (shot) => shot.area)

    // Short lanes share a row: wrap at the widest lane's width.
    const widest =
      Math.max(1, ...[...lanes.values()].map((lane) => lane.length)) * schemesShown().length

    world.style.width = `${widest * 1400}px`
    world.innerHTML = [...lanes]
      .map(
        ([area, lane]) =>
          `<section class="lane"><h3>${area}</h3><div class="lane-shots">${lane.map(laneFigure).join("")}</div></section>`,
      )
      .join("")
    detail = null
  }

  for (const figure of world.querySelectorAll("figure"))
    figure.toggleAttribute("aria-current", figure.dataset["id"] === shots[current]?.id)

  if (first) return fit()

  // Coming back from One view: center the current shot at the same zoom.
  const at = world.querySelector("figure[aria-current]")

  if (at === null) return showDetail()

  const box = at.getBoundingClientRect()
  const frame = canvas.getBoundingClientRect()
  camera.x += frame.left + frame.width / 2 - (box.left + box.width / 2)
  camera.y += frame.top + frame.height / 2 - (box.top + Math.min(box.height, frame.height) / 2)

  return applyCamera()
}

let drag: {
  readonly id: number
  x: number
  y: number
  moved: boolean
  readonly figure: HTMLElement | null
} | null = null

const endDrag = () => {
  drag = null
  canvas.classList.remove("dragging")
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.button !== 1) return

  if (event.target instanceof Element && event.target.closest(".zoom") !== null) return

  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    moved: false,
    figure: figureAt(event.target),
  }
  canvas.setPointerCapture(event.pointerId)
})

canvas.addEventListener("pointermove", (event) => {
  if (drag === null || drag.id !== event.pointerId) return

  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y

  if (!drag.moved && Math.hypot(dx, dy) < 4) return

  drag.moved = true
  canvas.classList.add("dragging")
  camera.x += dx
  camera.y += dy
  drag.x = event.clientX
  drag.y = event.clientY
  applyCamera()
})

canvas.addEventListener("pointerup", (event) => {
  if (drag === null || drag.id !== event.pointerId) return

  const clicked = drag.moved ? undefined : drag.figure?.dataset["id"]
  endDrag()

  if (clicked !== undefined) location.hash = clicked
})

canvas.addEventListener("pointercancel", endDrag)

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault()

    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? canvas.clientHeight
          : 1

    const box = canvas.getBoundingClientRect()
    // A pinch sends small deltas and a mouse wheel notch about 100, so cap each event's step.
    const delta = Math.max(-30, Math.min(30, event.deltaY * unit))

    if (event.ctrlKey || event.metaKey)
      return zoomAt(
        event.clientX - box.left,
        event.clientY - box.top,
        camera.z * Math.exp(-delta * 0.01),
      )

    const sideways = event.shiftKey && event.deltaX === 0
    camera.x -= (sideways ? event.deltaY : event.deltaX) * unit
    camera.y -= (sideways ? 0 : event.deltaY) * unit

    return applyCamera()
  },
  { passive: false },
)

element("zoom-in", HTMLButtonElement).addEventListener("click", () => zoomCenter(1.25))

element("zoom-out", HTMLButtonElement).addEventListener("click", () => zoomCenter(0.8))

element("zoom-fit", HTMLButtonElement).addEventListener("click", fit)

const render = () => {
  const shown = visible()
  let area: string | null = null
  let html = ""

  for (const shot of shown) {
    if (shot.area !== area) {
      area = shot.area
      html += `<h2>${area}</h2>`
    }

    const here = shots[current] === shot && view !== "grid" ? ' aria-current="true"' : ""
    html += `<a href="#${shot.id}"${here}>${shot.name}</a>`
  }

  list.innerHTML = html

  for (const button of document.querySelectorAll<HTMLElement>("[data-scheme]"))
    button.setAttribute("aria-pressed", String(button.dataset["scheme"] === scheme))

  for (const button of document.querySelectorAll<HTMLElement>("[data-view]"))
    button.setAttribute("aria-pressed", String(button.dataset["view"] === view))

  stage.hidden = view === "canvas"
  canvas.hidden = view !== "canvas"

  if (view === "canvas") {
    title.innerHTML = `Canvas <span>· ${shown.length}</span>`

    return buildWorld(shown)
  }

  if (view === "grid") {
    showing++
    stage.className = "grid"
    title.innerHTML = `All states <span>· ${shown.length}</span>`
    stage.innerHTML = shown
      .map((shot) => gridFigure(shot, scheme === "dark" ? "dark" : "light"))
      .join("")

    return undefined
  }

  const shot = shots[current]

  if (shot === undefined) return undefined

  title.innerHTML = `${shot.area} <span>/ ${shot.name}</span>`
  showStage(shot)
  list.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" })

  return undefined
}

const show = (id: string) => {
  const index = shots.findIndex((shot) => shot.id === id)

  if (index >= 0) {
    current = index
    view = "single"
  }

  render()
}

const step = (by: number) => {
  const shown = visible()
  const at = shots[current]
  const index = at === undefined ? -1 : shown.indexOf(at)
  const next = shown[(index + by + shown.length) % shown.length]

  if (next === undefined) return

  history.replaceState(null, "", `#${next.id}`)
  show(next.id)
}

const nextScheme = { light: "dark", dark: "both", both: "light" } as const

window.addEventListener("hashchange", () => show(location.hash.slice(1)))

filter.addEventListener("input", render)

stage.addEventListener("click", (event) => {
  const id = figureAt(event.target)?.dataset["id"]

  if (view === "grid" && id !== undefined) location.hash = id
})

for (const button of document.querySelectorAll<HTMLElement>("[data-scheme]"))
  button.addEventListener("click", () => {
    scheme = schemeChoices.find((choice) => choice === button.dataset["scheme"]) ?? scheme
    render()
  })

for (const button of document.querySelectorAll<HTMLElement>("[data-view]"))
  button.addEventListener("click", () => {
    view = viewChoices.find((choice) => choice === button.dataset["view"]) ?? view
    render()
  })

const pans = new Map<string, readonly [number, number]>([
  ["ArrowLeft", [1, 0]],
  ["ArrowRight", [-1, 0]],
  ["ArrowUp", [0, 1]],
  ["ArrowDown", [0, -1]],
])

const canvasKey = (event: KeyboardEvent) => {
  const pan = pans.get(event.key)

  if (pan !== undefined) {
    event.preventDefault()
    camera.x += pan[0] * 120
    camera.y += pan[1] * 120
    applyCamera()

    return true
  }

  if (event.key === "=" || event.key === "+") zoomCenter(1.25)
  else if (event.key === "-") zoomCenter(0.8)
  else if (event.key === "0" || event.key === "f") fit()
  else return false

  return true
}

document.addEventListener("keydown", (event) => {
  if (event.target === filter) {
    if (event.key === "Escape") filter.blur()

    return
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return

  if (view === "canvas" && canvasKey(event)) return

  if (event.key === "c") {
    view = view === "canvas" ? "single" : "canvas"
    render()
  } else if (event.key === "ArrowDown" || event.key === "ArrowRight" || event.key === "j") {
    event.preventDefault()
    step(1)
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "k") {
    event.preventDefault()
    step(-1)
  } else if (event.key === "d") {
    scheme = nextScheme[scheme]
    render()
  } else if (event.key === "g") {
    view = view === "grid" ? "single" : "grid"
    render()
  } else if (event.key === "/") {
    event.preventDefault()
    filter.focus()
  }
})

show(location.hash.slice(1) || (shots[0]?.id ?? ""))
