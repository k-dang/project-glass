import type { PlaceTag } from "@glass/contracts"
import {
  BROWSER_PARTITION,
  BROWSER_RELAY_CHANNEL,
  SANDBOX_BROWSER_PARTITION,
  THREAD_FILE_SCHEME,
  VISUALIZATION_SCHEME,
} from "@glass/contracts/desktop"
import { app, ipcMain, type Session, session, type WebContents, webContents } from "electron"
import { isIP } from "node:net"
import { publicAddressCheck, startSandboxProxy } from "./sandboxProxy"

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

const reachesPrivateNetwork = async (resolver: Session, page: string) => {
  const url = URL.parse(page)

  if (url === null || url.hostname === "") return true

  const host = url.hostname.replace(/^\[(.*)\]$/, "$1")

  const isPublic = publicAddressCheck()

  if (isIP(host) !== 0) return !isPublic(host)

  try {
    const { endpoints } = await resolver.resolveHost(host)

    return !endpoints.every((endpoint) => isPublic(endpoint.address))
  } catch {
    return true
  }
}

export const keepVisualizationsOffThisDevice = () => {
  const glass = session.defaultSession

  glass.webRequest.onBeforeRequest({ urls: ["https://*/*"] }, (details, callback) => {
    if (details.frame?.url.startsWith(`${VISUALIZATION_SCHEME}:`) !== true) return callback({})

    void reachesPrivateNetwork(glass, details.url).then((cancel) => callback({ cancel }))
  })
}

export const threadFileOf = (request: Request) => {
  const url = URL.parse(request.url)

  if (
    url === null ||
    ("initiatorOrigin" in request && request.initiatorOrigin !== `${url.protocol}//${url.host}`)
  )
    return null

  try {
    return {
      threadId: url.hostname,
      path: url.pathname.slice(1).split("/").map(decodeURIComponent),
    }
  } catch {
    return null
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
  readonly threadFileUrl: (
    place: PlaceTag,
    file: NonNullable<ReturnType<typeof threadFileOf>>,
  ) => Promise<string | null>
}) => {
  const setUp = (browser: Session, place: PlaceTag) => {
    browser.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission)),
    )
    browser.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.has(permission),
    )
    browser.protocol.handle(THREAD_FILE_SCHEME, async (request) => {
      const file = threadFileOf(request)

      try {
        const url = file === null ? null : await options.threadFileUrl(place, file)

        return url === null ? new Response("No such file.", { status: 404 }) : await fetch(url)
      } catch {
        return new Response("Glass's backend isn't answering", { status: 503 })
      }
    })
  }

  const local = session.fromPartition(BROWSER_PARTITION)
  const sandbox = session.fromPartition(SANDBOX_BROWSER_PARTITION)
  const browsers = [local, sandbox]

  setUp(local, "local")
  setUp(sandbox, "sandbox")

  // WARNING: Relays load Effect, which would delay the window if imported before it shows.
  let relays: Promise<ReturnType<typeof import("./pageRelays").pageRelays>> | undefined

  ipcMain.handle(BROWSER_RELAY_CHANNEL, async (event, webContentsId: number) => {
    const pane = webContents.fromId(webContentsId)

    if (pane?.hostWebContents !== event.sender || pane.session !== local)
      throw new Error("Only a local Thread's Browser pane can be driven")

    relays ??= import("./pageRelays").then(({ pageRelays }) => pageRelays())

    return (await relays)(pane)
  })

  const proxied = startSandboxProxy(publicAddressCheck).then(({ port }) =>
    sandbox.setProxy({
      proxyRules: `socks5://127.0.0.1:${port}`,
      proxyBypassRules: "<-loopback>",
    }),
  )

  proxied.catch((cause: unknown) =>
    console.error("Sandbox Browser panes can't load pages: their proxy didn't start", cause),
  )

  sandbox.webRequest.onBeforeRequest(
    (_details, callback) =>
      void proxied.then(
        () => callback({}),
        () => callback({ cancel: true }),
      ),
  )

  app.on("web-contents-created", (_event, contents) => {
    if (browsers.includes(contents.session)) keepToPages(contents)

    if (contents.session === sandbox) contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")

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
      // WARNING: A covered or minimized window hides its pages, and a hidden page stops painting, so the agent's clicks would wait on it.
      webPreferences.backgroundThrottling = false
    })
  })
}
