import { readFileSync } from "node:fs"
import { join } from "node:path"
import { transformWithOxc } from "vite-plus"
import type { Shot } from "./shot.ts"

const style = readFileSync(join(import.meta.dirname, "viewer.css"), "utf8")

const viewer = join(import.meta.dirname, "viewer.ts")

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export const galleryPage = async (shots: ReadonlyArray<Shot>, capturedAt: Date) => {
  const { code } = await transformWithOxc(readFileSync(viewer, "utf8"), viewer)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glass App States</title>
<style>${style}</style>
</head>
<body>
<nav>
  <header>
    <h1>Glass app states</h1>
    <div class="meta">${shots.length} states · captured ${escape(capturedAt.toLocaleString())}</div>
    <input id="filter" type="search" placeholder="Filter  ( / )" aria-label="Filter states">
  </header>
  <div id="list"></div>
</nav>
<main>
  <div class="bar">
    <div class="title" id="title"></div>
    <span class="keys">j k move · d theme · w whole window · g grid · c canvas</span>
    <div class="seg"><button data-view="single">One</button><button data-view="grid">Grid</button><button data-view="canvas">Canvas</button></div>
    <div class="seg"><button data-framing="focus">Focus</button><button data-framing="whole">Whole window</button></div>
    <div class="seg"><button data-scheme="light">Light</button><button data-scheme="dark">Dark</button><button data-scheme="both">Both</button></div>
  </div>
  <div id="stage"></div>
  <div id="canvas" hidden aria-label="Canvas of every state">
    <div id="world"></div>
    <div class="zoom"><button id="zoom-out" aria-label="Zoom out">−</button><output id="zoom-level">100%</output><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-fit">Fit</button></div>
  </div>
</main>
<script type="application/json" id="shots">${JSON.stringify(shots).replaceAll("<", "\\u003c")}</script>
<script type="module">${code}</script>
</body>
</html>
`
}
