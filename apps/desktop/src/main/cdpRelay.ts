import { Option, Schema } from "effect"

type JsonObject = Schema.JsonObject

export interface RelayedPage {
  readonly send: (
    method: string,
    params: JsonObject,
    sessionId: string | undefined,
  ) => Promise<Schema.Json>
  readonly targetId: () => Promise<string>
  readonly url: () => string
  readonly title: () => string
  readonly userAgent: () => string
}

const Command = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  sessionId: Schema.optional(Schema.String),
})

type Command = typeof Command.Type

const commandOf = Schema.decodeUnknownOption(Schema.fromJsonString(Command))

const BROWSER_CONTEXT_ID = "glass-browser-pane"

const PAGE_SESSION_ID = "glass-browser-pane-page"

const IGNORED = new Set([
  "Target.setDiscoverTargets",
  "Target.detachFromTarget",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setDownloadBehavior",
])

const PAGE_IGNORED = new Set([
  "Runtime.runIfWaitingForDebugger",
  "Emulation.setFocusEmulationEnabled",
])

interface Reply {
  readonly result: Schema.Json
  readonly followedBy?: Schema.JsonObject
}

export const relayTo = (page: RelayedPage, write: (message: string) => void) => {
  const browserSessions = new Set<string>()
  let attached = false
  let sessions = 0
  let runtimeReset: Promise<Schema.Json> | undefined

  let targetId: Promise<string> | undefined

  const targetInfo = async (): Promise<JsonObject> => ({
    targetId: await (targetId ??= page.targetId()),
    type: "page",
    title: page.title(),
    url: page.url(),
    attached: true,
    canAccessOpener: false,
    browserContextId: BROWSER_CONTEXT_ID,
  })

  const browserCommand = async (command: Command): Promise<Reply> => {
    if (IGNORED.has(command.method)) return { result: {} }

    switch (command.method) {
      case "Browser.getVersion":
        return {
          result: {
            protocolVersion: "1.3",
            product: "Electron",
            revision: "",
            userAgent: page.userAgent(),
            jsVersion: "",
          },
        }
      case "Target.getTargetInfo":
        return {
          result: {
            targetInfo: {
              targetId: "browser",
              type: "browser",
              title: "",
              url: "",
              attached: true,
              canAccessOpener: false,
            },
          },
        }
      case "Target.getBrowserContexts":
        return { result: { browserContextIds: [] } }
      case "Target.getTargets":
        return { result: { targetInfos: [await targetInfo()] } }
      case "Target.attachToBrowserTarget": {
        const sessionId = `glass-browser-${++sessions}`
        browserSessions.add(sessionId)

        return { result: { sessionId } }
      }

      case "Target.setAutoAttach": {
        if (attached) return { result: {} }

        attached = true

        return {
          result: {},
          followedBy: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: PAGE_SESSION_ID,
              targetInfo: await targetInfo(),
              waitingForDebugger: false,
            },
          },
        }
      }

      default:
        throw new Error(`A Browser pane doesn't support ${command.method}`)
    }
  }

  const pageCommand = async (command: Command): Promise<Reply> => {
    const child = command.sessionId === PAGE_SESSION_ID ? undefined : command.sessionId
    const params = command.params ?? {}

    if (child === undefined && PAGE_IGNORED.has(command.method)) return { result: {} }

    // WARNING: The debugger keeps Runtime enabled from an earlier connection, and enabling it again reports no existing contexts, which Playwright waits for.
    if (child === undefined && command.method === "Runtime.enable") {
      runtimeReset ??= page.send("Runtime.disable", {}, undefined).catch(() => null)
      await runtimeReset
    }

    return { result: await page.send(command.method, params, child) }
  }

  return {
    receive: (raw: string) => {
      const decoded = commandOf(raw)

      if (Option.isNone(decoded)) return

      const command = decoded.value

      const toBrowser = command.sessionId === undefined || browserSessions.has(command.sessionId)

      const route = command.sessionId === undefined ? {} : { sessionId: command.sessionId }

      void (toBrowser ? browserCommand(command) : pageCommand(command)).then(
        ({ result, followedBy }) => {
          write(JSON.stringify({ id: command.id, result, ...route }))

          if (followedBy !== undefined) write(JSON.stringify(followedBy))
        },
        (cause: Error) =>
          write(
            JSON.stringify({
              id: command.id,
              error: { code: -32000, message: cause.message },
              ...route,
            }),
          ),
      )
    },
    event: (method: string, params: Schema.Json, sessionId: string | undefined) => {
      if (!attached) return

      write(JSON.stringify({ method, params, sessionId: sessionId || PAGE_SESSION_ID }))
    },
  }
}
