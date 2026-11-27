import { BROWSER_USER_INPUT_CHANNEL } from "@glass/contracts/desktop"
import { Schema } from "effect"
import type { WebContents } from "electron"
import { randomBytes } from "node:crypto"
import { type RawData, type WebSocket, WebSocketServer } from "ws"
import { relayTo } from "./cdpRelay"

const ATTACH_REFUSED = 4000

const TargetInfo = Schema.Struct({ targetInfo: Schema.Struct({ targetId: Schema.String }) })

const decodeTargetInfo = Schema.decodeUnknownPromise(TargetInfo)

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))

const TAKES_OVER: ReadonlySet<string> = new Set(["mouseDown", "rawKeyDown", "keyDown"])

const textOf = (data: RawData) =>
  Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data).toString("utf8")

const connect = (pane: WebContents, socket: WebSocket, replaced: () => boolean) => {
  const { debugger: debuggee } = pane

  try {
    if (!debuggee.isAttached()) debuggee.attach("1.3")
  } catch {
    socket.close(ATTACH_REFUSED, "Another debugger is attached to this page")

    return
  }

  const relay = relayTo(
    {
      send: (method, params, sessionId): Promise<Schema.Json> =>
        debuggee.sendCommand(method, params, sessionId),
      key: (key) => pane.sendInputEvent(key),
      targetId: async () =>
        (await decodeTargetInfo(await debuggee.sendCommand("Target.getTargetInfo"))).targetInfo
          .targetId,
      url: () => pane.getURL(),
      title: () => pane.getTitle(),
      userAgent: () => pane.getUserAgent(),
    },
    (message) => socket.send(message),
  )

  const onEvent = (
    _event: Electron.Event,
    method: string,
    params: Schema.Json,
    sessionId: string,
  ) => relay.event(method, params, sessionId)

  const onDetach = () => socket.close()

  // WARNING: Electron reports the agent's input like the user's, so input reported while a relayed Input command waits for its answer, including during sendInputEvent, is the agent's.
  const onInput = (_event: Electron.Event, input: Electron.InputEvent) => {
    if (TAKES_OVER.has(input.type) && !relay.sendingInput())
      pane.hostWebContents?.send(BROWSER_USER_INPUT_CHANNEL, pane.id)
  }

  debuggee.on("message", onEvent)
  debuggee.on("detach", onDetach)
  pane.on("input-event", onInput)
  socket.on("message", (data) => relay.receive(textOf(data)))
  socket.once("close", () => {
    debuggee.off("message", onEvent)
    debuggee.off("detach", onDetach)
    pane.off("input-event", onInput)

    if (!replaced() && !pane.isDestroyed() && debuggee.isAttached()) debuggee.detach()
  })
}

const open = (pane: WebContents, forget: () => void) =>
  new Promise<string>((resolve, reject) => {
    const secret = randomBytes(24).toString("base64url")
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: `/${secret}` })
    let current: WebSocket | null = null

    server.once("error", (cause) => {
      forget()
      reject(cause)
    })
    server.once("listening", () =>
      resolve(`ws://127.0.0.1:${decodeAddress(server.address()).port}/${secret}`),
    )
    server.on("connection", (socket) => {
      const previous = current
      current = socket
      previous?.close()
      connect(pane, socket, () => current !== socket)
    })
    pane.once("destroyed", () => {
      forget()
      server.close()
    })
  })

export const pageRelays = () => {
  const relays = new Map<number, Promise<string>>()

  return (pane: WebContents) => {
    const known = relays.get(pane.id)

    if (known !== undefined) return known

    const opened = open(pane, () => relays.delete(pane.id))
    relays.set(pane.id, opened)

    return opened
  }
}
