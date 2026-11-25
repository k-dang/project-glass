import { _electron, type ElectronApplication, type Locator, type Page } from "@playwright/test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeGlassHome } from "../server/test/glassHome.ts"
import { galleryPage } from "./page.ts"
import type { Shot, Size } from "./shot.ts"
import { replayedStates, replays, states } from "./states.ts"

const desktopDir = join(import.meta.dirname, "..", "desktop")

const out = join(import.meta.dirname, "..", "..", ".gallery")

const viewport = { width: 1280, height: 800 }

const shots: Array<Shot> = []

const failures: Array<string> = []

const firstLine = (text: string) => text.split("\n")[0]

const fitTranscript = async (window: Page) => {
  const hidden = await window
    .getByRole("region", { name: "Transcript" })
    .evaluate((transcript) =>
      Math.max(
        0,
        ...[transcript, ...transcript.querySelectorAll("*")].map(
          (element) => element.scrollHeight - element.clientHeight,
        ),
      ),
    )

  await window.setViewportSize({ ...viewport, height: Math.min(viewport.height + hidden, 6000) })
}

const clipAround = async (focus: Locator, padding: number, { width, height }: Size) => {
  await focus.first().waitFor()

  const boxes = (await Promise.all((await focus.all()).map((part) => part.boundingBox()))).flatMap(
    (box) => (box === null ? [] : [box]),
  )

  const x = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.x)) - padding))
  const y = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.y)) - padding))
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + padding
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + padding

  return {
    x,
    y,
    width: Math.min(width, Math.ceil(right)) - x,
    height: Math.min(height, Math.ceil(bottom)) - y,
  }
}

const writeThumbnail = async (app: ElectronApplication, from: string, to: string) => {
  const thumbnail = await app.evaluate(({ nativeImage }, path) => {
    const image = nativeImage.createFromPath(path)

    return (image.getSize().width > 320 ? image.resize({ width: 320, quality: "best" }) : image)
      .toPNG()
      .toString("base64")
  }, from)

  writeFileSync(to, Buffer.from(thumbnail, "base64"))
}

const capture = async (app: ElectronApplication) => {
  const thumbnails: Array<Promise<void>> = []
  const window = await app.firstWindow()
  window.setDefaultTimeout(60_000)
  await window.getByRole("main", { name: "Dashboard" }).waitFor()
  const all = [...states, ...replayedStates(await replays(window))]

  for (const [index, state] of all.entries()) {
    const label = `${state.area} / ${state.name}`
    const id = `${String(index + 1).padStart(2, "0")}-${`${state.area}-${state.name}`.toLowerCase().replaceAll(/\W+/g, "-")}`

    try {
      if ((await state.reach(window)) === "nothing new") {
        console.log(`- ${label}: nothing new to show`)
        continue
      }

      await window
        .getByText(/^Loading\b.*…$/)
        .filter({ visible: true })
        .first()
        .waitFor({ state: "detached" })

      if (state.wholeTranscript) await fitTranscript(window)

      const size = window.viewportSize() ?? viewport

      const clip =
        state.focus === undefined
          ? null
          : await clipAround(state.focus(window), state.focusPadding ?? 16, size)

      for (const scheme of ["light", "dark"] as const) {
        await window.emulateMedia({ colorScheme: scheme })

        const framings = [
          { path: join(out, "shots", `${id}-${scheme}`), options: {} },
          ...(clip === null
            ? []
            : [{ path: join(out, "shots", `${id}-${scheme}-focus`), options: { clip } }]),
        ]

        for (const framing of framings) {
          await window.screenshot({
            path: `${framing.path}.png`,
            ...framing.options,
            animations: "disabled",
          })
          thumbnails.push(
            writeThumbnail(app, `${framing.path}.png`, `${framing.path}-thumb.png`).catch(
              (error) => {
                failures.push(`${label} thumbnail: ${firstLine(String(error))}`)
              },
            ),
          )
        }
      }

      shots.push({
        id,
        area: state.area,
        name: state.name,
        ...size,
        focus: clip === null ? null : { width: clip.width, height: clip.height },
      })
      console.log(`✓ ${label}`)
    } catch (error) {
      const reason = `${label}: ${firstLine(String(error))}`
      failures.push(reason)
      console.error(`✗ ${reason}`)
    } finally {
      if (state.wholeTranscript) await window.setViewportSize(viewport)
    }
  }

  await Promise.all(thumbnails)
}

const home = mkdtempSync(join(tmpdir(), "glass-gallery-"))

try {
  const transcripts = join(home, "transcripts")
  const { ELECTRON_RUN_AS_NODE: _node, VITE_DEV_SERVER_URL: _devServer, ...inherited } = process.env
  const env = { ...inherited, GLASS_HOME: home, GLASS_FAKE_BACKEND: "1" }

  console.log("Replaying the recorded Claude Code and pi sessions...")

  const replay = spawnSync("pnpm --filter @glass/server exec vp test run Adapter.integration", {
    env: { ...env, GLASS_TRANSCRIPTS_DIR: transcripts },
    encoding: "utf8",
    shell: true,
  })

  if (replay.status !== 0) {
    console.error(replay.stdout, replay.stderr)
    throw new Error("Replaying the recorded sessions failed")
  }

  mkdirSync(out, { recursive: true })

  for (const entry of readdirSync(out)) rmSync(join(out, entry), { recursive: true, force: true })
  mkdirSync(join(out, "shots"))

  const app = await _electron.launch({
    executablePath: createRequire(join(desktopDir, "package.json"))("electron"),
    args: [
      "-r",
      join(desktopDir, "e2e", "background.cjs"),
      desktopDir,
      `--user-data-dir=${join(home, "user-data")}`,
    ],
    env: { ...env, GLASS_REPLAYED_TRANSCRIPTS: transcripts },
  })

  try {
    await capture(app)
  } finally {
    await app.close()
  }
} finally {
  await removeGlassHome(home)
}

writeFileSync(
  join(out, "index.html"),
  galleryPage({ shots, capturedAt: new Date().toLocaleString() }),
)

console.log(`\n${shots.length} states captured: ${join(out, "index.html")}`)

if (failures.length > 0) {
  console.error(`\nNot captured:\n${failures.map((failure) => `  ${failure}`).join("\n")}`)
  process.exitCode = 1
}
