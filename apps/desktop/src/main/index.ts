import {
  BACKEND_ENDPOINT_CHANNEL,
  BACKEND_FAILURE_CHANNEL,
  type BackendEndpoint,
  CHOOSE_FOLDER_CHANNEL,
  type BackendFailure,
  RELAUNCH_CHANNEL,
  RESOURCE_USAGE_CHANNEL,
  SET_THEME_CHANNEL,
  type Theme,
} from "@glass/contracts/desktop"
import { Cause, Effect, Fiber, Option } from "effect"
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from "electron"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { startBackend } from "./backend"
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
      // `pnpm dev:fake` swaps in the backend that runs on fakes.
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

let theme: Theme = "system"

const windowColors = () => {
  if (theme === "charcoal") return { color: "#111111", symbolColor: "#cecece" }

  return nativeTheme.shouldUseDarkColors
    ? { color: "#0a0a0a", symbolColor: "#fafafa" }
    : { color: "#ffffff", symbolColor: "#0a0a0a" }
}

const updateWindowTheme = (window: BrowserWindow) => {
  const colors = windowColors()
  window.setBackgroundColor(colors.color)

  if (process.platform !== "darwin") window.setTitleBarOverlay(colors)
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
      // Throttled timers in a hidden window can interrupt WebSocket pings.
      backgroundThrottling: false,
    },
  })

  const updateTheme = () => updateWindowTheme(window)

  nativeTheme.on("updated", updateTheme)
  window.once("closed", () => nativeTheme.off("updated", updateTheme))

  window.removeMenu()
  window.once("ready-to-show", () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url)

    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event) => {
    // Reloads, such as the Vite dev client's, stay in the window.
    if (event.url.startsWith(`${rendererOrigin}/`)) return

    event.preventDefault()
    openInBrowser(event.url)
  })
  void window.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`)
}

const logFile = join(process.env["GLASS_HOME"] || homedir(), ".glass", "logs", "backend.log")

const backendReady = Promise.withResolvers<BackendEndpoint>()

const backendFailed = Promise.withResolvers<BackendFailure>()

const reportFailure = (kind: BackendFailure["kind"], message: string) =>
  backendFailed.resolve({ kind, message, logFile })

const program = Effect.gen(function* () {
  const backend = yield* startBackend({
    entry: resources.server,
    rendererOrigin,
    logFile,
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
  ipcMain.handle(SET_THEME_CHANNEL, (_event, next: Theme) => {
    theme = next
    nativeTheme.themeSource = next === "charcoal" ? "dark" : next

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
  ipcMain.handle(RELAUNCH_CHANNEL, () => {
    app.relaunch()
    app.quit()
  })

  if (devServerUrl === undefined) serveRenderer()

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
