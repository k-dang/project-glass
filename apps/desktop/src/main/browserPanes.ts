import {
  BROWSER_PARTITION,
  BROWSER_RELAY_CHANNEL,
  isLoopbackHost,
  SANDBOX_BROWSER_PARTITION,
  THREAD_FILE_SCHEME,
} from "@glass/contracts/desktop"
import { app, ipcMain, type Session, session, type WebContents, webContents } from "electron"

const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
])

const PAGE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", `${THREAD_FILE_SCHEME}:`])

const PARTITIONS: ReadonlySet<string> = new Set([BROWSER_PARTITION, SANDBOX_BROWSER_PARTITION])

const POPUP = { width: 520, height: 680, autoHideMenuBar: true }

const opensInPane = (address: string) => {
  const url = URL.parse(address)

  return url !== null && (PAGE_PROTOCOLS.has(url.protocol) || url.href === "about:blank")
}

const isLoopbackAddress = (address: string) => {
  const url = URL.parse(`http://${address.includes(":") ? `[${address}]` : address}/`)

  return url !== null && isLoopbackHost(url.hostname)
}

const reachesThisDevice = async (resolver: Session, address: string) => {
  const url = URL.parse(address)

  if (url === null || url.hostname === "") return false

  if (isLoopbackHost(url.hostname)) return true

  try {
    const { endpoints } = await resolver.resolveHost(url.hostname)

    return endpoints.some((endpoint) => isLoopbackAddress(endpoint.address))
  } catch {
    return false
  }
}

const keepToPage = (event: { readonly url: string; preventDefault: () => void }) => {
  if (!opensInPane(event.url)) event.preventDefault()
}

const keepToPages = (contents: WebContents) => {
  contents.setWindowOpenHandler(({ url }) =>
    opensInPane(url)
      ? { action: "allow", overrideBrowserWindowOptions: POPUP }
      : { action: "deny" },
  )
  contents.on("will-navigate", keepToPage)
  contents.on("will-redirect", keepToPage)
}

export const setUpBrowserPanes = (options: {
  readonly preload: string
  readonly threadFile: (threadId: string, pathname: string) => Promise<Response>
}) => {
  const setUp = (browser: Session) => {
    browser.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission)),
    )
    browser.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.has(permission),
    )
    browser.protocol.handle(THREAD_FILE_SCHEME, async (request) => {
      const { hostname, pathname } = new URL(request.url)

      try {
        return await options.threadFile(hostname, pathname)
      } catch {
        return new Response("Glass's backend isn't answering", { status: 503 })
      }
    })
  }

  const local = session.fromPartition(BROWSER_PARTITION)
  const sandbox = session.fromPartition(SANDBOX_BROWSER_PARTITION)
  const browsers = [local, sandbox]

  for (const browser of browsers) setUp(browser)

  // WARNING: Relays load Effect, which would delay the window if imported before it shows.
  const relays = import("./pageRelays").then(({ pageRelays }) => pageRelays())

  ipcMain.handle(BROWSER_RELAY_CHANNEL, async (event, webContentsId: number) => {
    const pane = webContents.fromId(webContentsId)

    if (pane?.hostWebContents !== event.sender || pane.session !== local)
      throw new Error("Only a local Thread's Browser pane can be driven")

    return (await relays)(pane)
  })

  sandbox.webRequest.onBeforeRequest(
    (details, callback) =>
      void reachesThisDevice(sandbox, details.url).then((cancel) => callback({ cancel })),
  )

  app.on("web-contents-created", (_event, contents) => {
    if (browsers.includes(contents.session)) keepToPages(contents)

    contents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        contents.session !== session.defaultSession ||
        !PARTITIONS.has(params.partition ?? "") ||
        params.src !== "about:blank"
      ) {
        event.preventDefault()

        return
      }

      // WARNING: Electron reads the allowpopups attribute into this before the event, and React can't set that attribute.
      Object.assign(webPreferences, { disablePopups: false })
      webPreferences.preload = options.preload
      webPreferences.contextIsolation = true
      webPreferences.nodeIntegration = false
      webPreferences.sandbox = true
    })
  })
}
