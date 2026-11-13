import {
  BACKEND_ENDPOINT_CHANNEL,
  BACKEND_FAILURE_CHANNEL,
  type BackendEndpoint,
  CHOOSE_FOLDER_CHANNEL,
  type BackendFailure,
  DISCARD_DOGFOOD_REPORT_CHANNEL,
  type DogfoodReportDetails,
  type DogfoodReportRecorded,
  FINISH_DOGFOOD_REPORT_CHANNEL,
  RECORD_DOGFOOD_REPORT_CHANNEL,
  RELAUNCH_CHANNEL,
  RESOURCE_USAGE_CHANNEL,
  SET_APPEARANCE_CHANNEL,
  type Appearance,
} from "@glass/contracts/desktop"
import type { Theme } from "@glass/contracts"
import { Cause, Effect, Fiber, Option } from "effect"
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  net,
  protocol,
  shell,
} from "electron"
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { startBackend } from "./backend"
import { dogfoodReportWriter } from "./dogfoodReports"
import { prependLoginShellPath } from "./loginShellPath"
import { summarizeResourceUsage } from "./resourceUsage"

const devServerUrl = process.env["VITE_DEV_SERVER_URL"]

const APP_SCHEME = "glass"

const APP_ORIGIN = `${APP_SCHEME}://app`

const rendererOrigin = devServerUrl === undefined ? APP_ORIGIN : new URL(devServerUrl).origin

const resources = app.isPackaged
  ? {
      server: join(process.resourcesPath, "server", "bin.mjs"),
      renderer: join(process.resourcesPath, "renderer"),
    }
  : {
      server: join(
        __dirname,
        "../../../server",
        process.env["GLASS_FAKE_BACKEND"] ? "dist-fake/fakeBackend.mjs" : "dist/bin.mjs",
      ),
      renderer: join(__dirname, "../renderer"),
    }

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Diffs injects <style> elements and inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://github.com https://*.githubusercontent.com",
  "media-src https://github.com https://*.githubusercontent.com",
  "connect-src ws://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ")

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const serveRenderer = () =>
  protocol.handle(APP_SCHEME, async (request) => {
    const filePath = join(resources.renderer, decodeURIComponent(new URL(request.url).pathname))

    if (relative(resources.renderer, filePath).startsWith("..")) {
      return new Response("Not found", { status: 404 })
    }

    const response = await net.fetch(pathToFileURL(filePath).toString())
    const headers = new Headers(response.headers)
    headers.set("content-security-policy", CONTENT_SECURITY_POLICY)

    return new Response(response.body, { status: response.status, headers })
  })

const openInBrowser = (url: string) => {
  const scheme = new URL(url).protocol

  if (scheme === "https:" || scheme === "http:") void shell.openExternal(url)
}

let theme: Theme = "glass"

const titleBarColors = {
  glass: {
    light: { color: "#ffffff", symbolColor: "#0a0a0a" },
    dark: { color: "#0a0a0a", symbolColor: "#fafafa" },
  },
  charcoal: {
    light: { color: "#f4f4f4", symbolColor: "#2b2b2b" },
    dark: { color: "#111111", symbolColor: "#cecece" },
  },
  catppuccin: {
    light: { color: "#e6e9ef", symbolColor: "#4c4f69" },
    dark: { color: "#181825", symbolColor: "#cdd6f4" },
  },
  linear: {
    light: { color: "#fcfcfd", symbolColor: "#282a30" },
    dark: { color: "#010102", symbolColor: "#f7f8f8" },
  },
  vercel: {
    light: { color: "#fafafa", symbolColor: "#171717" },
    dark: { color: "#000000", symbolColor: "#ededed" },
  },
} satisfies Record<Theme, Record<"light" | "dark", { color: string; symbolColor: string }>>

const windowColors = () => titleBarColors[theme][nativeTheme.shouldUseDarkColors ? "dark" : "light"]

const updateWindowTheme = (window: BrowserWindow) => {
  const colors = windowColors()
  window.setBackgroundColor(colors.color)

  if (process.platform !== "darwin") window.setTitleBarOverlay(colors)
}

const glassHome = process.env["GLASS_HOME"] || homedir()

const logFile = join(glassHome, ".glass", "logs", "backend.log")

// The backend keeps its data here; main passes it as GLASS_DATA_DIRECTORY.
const dataDirectory = join(glassHome, ".project-glass")

// Dogfood reports live beside Glass's data, never in a repository.
const dogfoodReports = dogfoodReportWriter(join(dataDirectory, "dogfood-reports"))

const glassCommit = () =>
  new Promise<string>((resolve) =>
    execFile("git", ["describe", "--always", "--dirty"], { cwd: app.getAppPath() }, (error, out) =>
      resolve(error === null ? out.trim() : "unknown"),
    ),
  )

const recordDogfoodReportOf = async (window: BrowserWindow): Promise<DogfoodReportRecorded> => {
  const now = new Date()
  const [image, commit] = await Promise.all([window.webContents.capturePage(), glassCommit()])

  const id = await dogfoodReports.record({
    screenshot: image.toPNG(),
    backendLogPath: logFile,
    settingsPath: join(dataDirectory, "settings.json"),
    glassCommit: commit,
    now,
  })

  const thumbnail = image.resize({ width: 640 }).toJPEG(70).toString("base64")

  return { id, screenshot: `data:image/jpeg;base64,${thumbnail}` }
}

const createWindow = () => {
  const initialColors = windowColors()

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: "Glass",
    titleBarStyle: "hidden",
    titleBarOverlay: { height: 36, ...initialColors },
    show: false,
    backgroundColor: initialColors.color,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // Throttled timers in a hidden window can interrupt WebSocket pings.
      backgroundThrottling: false,
    },
  })

  const updateTheme = () => updateWindowTheme(window)

  nativeTheme.on("updated", updateTheme)
  window.once("closed", () => nativeTheme.off("updated", updateTheme))

  window.removeMenu()
  window.webContents.on("context-menu", (_event, params) => {
    const { webContents } = window
    const { editFlags, isEditable, misspelledWord, selectionText } = params
    const items: MenuItemConstructorOptions[] = []

    if (isEditable) {
      if (misspelledWord) {
        for (const suggestion of params.dictionarySuggestions) {
          items.push({
            label: suggestion,
            click: () => webContents.replaceMisspelling(suggestion),
          })
        }

        if (params.dictionarySuggestions.length === 0)
          items.push({ label: "No spelling suggestions", enabled: false })

        items.push(
          {
            label: "Add to dictionary",
            click: () => {
              webContents.session.addWordToSpellCheckerDictionary(misspelledWord)
            },
          },
          { type: "separator" },
        )
      }

      items.push(
        { role: "cut", enabled: editFlags.canCut },
        { role: "copy", enabled: editFlags.canCopy },
        { role: "paste", enabled: editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: editFlags.canSelectAll },
      )
    } else if (selectionText) {
      items.push({ role: "copy", enabled: editFlags.canCopy })
    }

    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window })
  })
  window.once("ready-to-show", () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url)

    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event) => {
    if (event.url.startsWith(`${rendererOrigin}/`)) return

    event.preventDefault()
    openInBrowser(event.url)
  })
  void window.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`)
}

const backendReady = Promise.withResolvers<BackendEndpoint>()

const backendFailed = Promise.withResolvers<BackendFailure>()

const reportFailure = (kind: BackendFailure["kind"], message: string) =>
  backendFailed.resolve({ kind, message, logFile })

const program = Effect.gen(function* () {
  if (app.isPackaged && process.platform !== "win32") {
    yield* prependLoginShellPath(process.env, [
      process.env["SHELL"],
      process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
    ])
  }

  const backend = yield* startBackend({
    entry: resources.server,
    rendererOrigin,
    logFile,
    dataDirectory,
  })

  backendReady.resolve(backend.endpoint)
  reportFailure("crash", (yield* Effect.flip(backend.failed)).message)
}).pipe(
  Effect.scoped,
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      if (Cause.hasInterruptsOnly(cause)) return

      Option.match(Cause.findErrorOption(cause), {
        onSome: (error) => reportFailure("start", error.message),
        onNone: () => {
          console.error(Cause.pretty(cause))
          reportFailure("start", "Unexpected error while starting the backend")
        },
      })
    }),
  ),
)

void app.whenReady().then(() => {
  ipcMain.handle(BACKEND_ENDPOINT_CHANNEL, () => backendReady.promise)
  ipcMain.handle(BACKEND_FAILURE_CHANNEL, () => backendFailed.promise)
  ipcMain.handle(RESOURCE_USAGE_CHANNEL, () => summarizeResourceUsage(app.getAppMetrics()))
  ipcMain.handle(SET_APPEARANCE_CHANNEL, (_event, next: Appearance) => {
    theme = next.theme
    nativeTheme.themeSource = next.colorScheme

    for (const window of BrowserWindow.getAllWindows()) updateWindowTheme(window)

    return nativeTheme.shouldUseDarkColors ? "dark" : "light"
  })
  ipcMain.handle(CHOOSE_FOLDER_CHANNEL, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { properties: ["openDirectory" as const] }

    const chosen =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options)

    return chosen.canceled ? null : (chosen.filePaths[0] ?? null)
  })

  ipcMain.handle(RECORD_DOGFOOD_REPORT_CHANNEL, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)

    if (window === null) throw new Error("No window to record")

    return recordDogfoodReportOf(window)
  })
  ipcMain.handle(FINISH_DOGFOOD_REPORT_CHANNEL, (_event, details: DogfoodReportDetails) =>
    dogfoodReports.finish(details),
  )
  ipcMain.handle(DISCARD_DOGFOOD_REPORT_CHANNEL, (_event, id: string) => dogfoodReports.discard(id))

  ipcMain.handle(RELAUNCH_CHANNEL, () => {
    app.relaunch()
    app.quit()
  })

  if (devServerUrl === undefined) serveRenderer()

  if (!app.isPackaged) app.dock?.setIcon(join(__dirname, "../../build/icon.png"))

  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  const fiber = Effect.runFork(program)

  app.on("will-quit", (event) => {
    if (fiber.pollUnsafe() !== undefined) return
    event.preventDefault()
    void Effect.runPromise(Fiber.interrupt(fiber)).finally(() => app.quit())
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
