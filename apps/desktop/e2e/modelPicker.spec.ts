import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as glass } from "./glass"

const test = glass.extend({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from it.
  home: async ({}, use) => {
    const home = await mkdtemp(join(tmpdir(), "glass-model-picker-"))
    const plugins = join(home, ".project-glass", "plugins")
    await mkdir(plugins, { recursive: true })
    await writeFile(
      join(plugins, "models.js"),
      `import { existsSync, watch } from "node:fs"
const release = ${JSON.stringify(join(home, "release-models"))}
const home = ${JSON.stringify(home)}
export default (glass) => {
  let failed = false
  glass.registerSandboxProvider("models", {
    name: "Model picker Sandboxes",
    engines: ["claude-code", "pi"],
    models: async (engine) => {
      if (engine === "pi" && !failed) {
        if (!existsSync(release)) await new Promise((resolve) => {
          const watcher = watch(home, () => {
            if (existsSync(release)) { watcher.close(); resolve() }
          })
          if (existsSync(release)) { watcher.close(); resolve() }
        })
        failed = true
        throw new Error("Model catalog unavailable")
      }
      const models = Array.from({ length: engine === "pi" ? 30 : 3 }, (_, i) => ({
        id: engine + "/" + i, name: engine + " model " + i, efforts: [],
      }))
      return { defaultModel: models[0], models }
    },
    create: async () => { throw new Error("This test starts no Agent") },
    target: async () => { throw new Error("This test starts no Agent") },
    remove: async () => {},
  })
}
`,
    )

    await use(home)
    await rm(home, { recursive: true, force: true })
  },
})

for (const viewport of [
  { width: 1280, height: 820 },
  { width: 720, height: 480 },
]) {
  test(`keeps model choices within ${viewport.width}×${viewport.height} through program changes`, async ({
    app,
    home,
    window,
  }) => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setBackgroundThrottling(false)
    })
    await window.setViewportSize(viewport)
    await window.emulateMedia({
      reducedMotion: viewport.width === 720 ? "reduce" : "no-preference",
    })
    await window.getByRole("link", { name: "Agents", exact: true }).click()
    const trigger = window.getByRole("button", { name: "Claude Code: claude-code model 0" })
    await trigger.click()
    const popup = window.getByRole("dialog")
    await expect(popup).toHaveCSS("scale", "none")
    const programs = popup.getByRole("group", { name: "Agent program" })
    const claude = programs.getByRole("button", { name: "Claude Code", exact: true })
    const pi = programs.getByRole("button", { name: "pi", exact: true })
    const position = await programs.boundingBox()
    const composer = await window.locator("form").boundingBox()

    const stable = async () => {
      await expect(async () => {
        expect(await programs.boundingBox()).toEqual(position)
        expect(await window.locator("form").boundingBox()).toEqual(composer)
        const bounds = await popup.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.y).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
        expect(
          await window.locator("html").evaluate((root) => ({
            height: root.scrollHeight,
            width: root.clientWidth,
          })),
        ).toEqual({ height: viewport.height, width: viewport.width })
      }).toPass()
    }

    await pi.click()
    await expect(popup.getByText("Loading models…")).toBeVisible()
    await stable()
    await expect(pi).toBeFocused()
    await claude.click()
    await pi.click()
    await claude.click()
    await pi.click()
    await expect(popup.getByText("Loading models…")).toBeVisible()
    await stable()

    await writeFile(join(home, "release-models"), "")
    await expect(popup.getByRole("alert")).toBeVisible()
    await stable()
    await popup.getByRole("button", { name: "Retry", exact: true }).click()
    const models = popup.getByRole("group", { name: "Model", exact: true })
    await expect(models.getByRole("button")).toHaveCount(31)
    await stable()

    await window.keyboard.press("Escape")
    await expect(popup).toHaveCount(0)
    const defaultTrigger = window.getByRole("button", { name: "pi: pi model 0", exact: true })
    await expect(defaultTrigger).toBeFocused()
    await defaultTrigger.press("Enter")
    await expect(claude).toBeFocused()
    await window.keyboard.press("Tab")
    const first = models.getByRole("button", { name: "Default pi model 0", exact: true })
    await expect(first).toBeFocused()
    await window.keyboard.press("End")
    const last = models.getByRole("button", { name: "pi model 29", exact: true })
    await expect(last).toBeFocused()
    await expect(last).toBeInViewport()
    expect(await models.evaluate((group) => group.parentElement!.scrollTop)).toBeGreaterThan(0)
    await stable()
    await expect(last).toBeFocused()
    await window.keyboard.press("Enter")
    await expect(popup).toHaveCount(0)
    const chosen = window.getByRole("button", { name: "pi: pi model 29", exact: true })
    await expect(chosen).toBeFocused()
    await chosen.click()
    await models.getByRole("button", { name: "Default pi model 0", exact: true }).click()
    await expect(popup).toHaveCount(0)
    await expect(window.getByRole("button", { name: "pi: pi model 0", exact: true })).toBeFocused()
  })
}
