import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { failedToolCall } from "../agentHost/protocol"
import { BrowserPages, BrowserUnavailable, PageLogEntry, ShownPage } from "../BrowserPages"
import { GlassToolFailure } from "./glassTools"
import { McpCaller } from "./McpCredentials"
import { forThreadsOnThisDevice } from "./toolAudience"

const callingThread = Effect.serviceOption(McpCaller).pipe(
  Effect.flatMap((caller) =>
    Option.isSome(caller) && Predicate.isTagged(caller.value, "Thread")
      ? Effect.succeed(caller.value.threadId)
      : Effect.fail(
          new BrowserUnavailable({ message: "Only a Thread's agent has a Browser pane to use." }),
        ),
  ),
)

const readsOnly = Context.make(Tool.Readonly, true).pipe(
  Context.add(Tool.Destructive, false),
  Context.add(Tool.OpenWorld, false),
  Context.merge(forThreadsOnThisDevice),
)

const OpenBrowser = Tool.make("open_browser", {
  description:
    "Opens a page in your Thread's Browser pane, the browser the user sees beside your Thread, and waits for it to load. Pass a full http or https address, such as your dev server's http://localhost:3000/. Without one, it opens the pane on the page it last showed. Returns the page's address and title. Then read_browser lists what's on it, screenshot_browser shows it, and browser_console lists its errors.",
  parameters: Schema.Struct({
    url: Schema.optional(
      Schema.Trimmed.check(Schema.isPattern(/^https?:\/\//i)).annotate({
        description: "The http or https address to open.",
      }),
    ),
  }),
  success: ShownPage,
  failure: GlassToolFailure,
}).annotateMerge(
  Context.make(Tool.Readonly, false).pipe(
    Context.add(Tool.Destructive, false),
    Context.add(Tool.Idempotent, false),
    Context.add(Tool.OpenWorld, false),
    Context.merge(forThreadsOnThisDevice),
  ),
)

const ReadBrowser = Tool.make("read_browser", {
  description:
    "Reads the page in your Thread's Browser pane: its address, title, and an accessibility snapshot of what's on it, as roles, names and text. open_browser opens a page first.",
  success: Schema.Struct({ ...ShownPage.fields, snapshot: Schema.String }),
  failure: GlassToolFailure,
}).annotateMerge(readsOnly)

const BrowserConsole = Tool.make("browser_console", {
  description:
    "Lists the console errors and warnings, uncaught page errors, and failed or HTTP 4xx/5xx requests of the page in your Thread's Browser pane since your browser tools last connected to it, oldest first.",
  success: Schema.Struct({ entries: Schema.Array(PageLogEntry) }),
  failure: GlassToolFailure,
}).annotateMerge(readsOnly)

const BrowserTools = Toolkit.make(OpenBrowser, ReadBrowser, BrowserConsole)

const toolFailure = ({ message }: BrowserUnavailable) => new GlassToolFailure({ message })

const BrowserToolHandlers = BrowserTools.toLayer(
  Effect.gen(function* () {
    const pages = yield* BrowserPages

    return BrowserTools.of({
      open_browser: ({ url }) =>
        callingThread.pipe(
          Effect.flatMap((threadId) => pages.open(threadId, url)),
          Effect.mapError(toolFailure),
        ),
      read_browser: () =>
        callingThread.pipe(Effect.flatMap(pages.read), Effect.mapError(toolFailure)),
      browser_console: () =>
        callingThread.pipe(
          Effect.flatMap(pages.consoleLog),
          Effect.map((entries) => ({ entries })),
          Effect.mapError(toolFailure),
        ),
    })
  }),
)

const decodeScreenshotInput = Schema.decodeUnknownEffect(
  Schema.Struct({ fullPage: Schema.optional(Schema.Boolean) }),
)

const screenshotTool = new McpSchema.Tool({
  name: "screenshot_browser",
  description:
    "Takes a screenshot of the page in your Thread's Browser pane, as the user sees it. Pass fullPage to capture the whole page rather than what fits the pane. open_browser opens a page first.",
  inputSchema: {
    type: "object",
    properties: {
      fullPage: {
        type: "boolean",
        description: "Capture the whole scrollable page, not just what fits the pane.",
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
})

const ScreenshotBrowser = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer
    const pages = yield* BrowserPages

    yield* server.addTool({
      tool: screenshotTool,
      annotations: forThreadsOnThisDevice,
      handle: (payload) =>
        Effect.gen(function* () {
          const { fullPage } = yield* decodeScreenshotInput(payload).pipe(
            Effect.mapError(
              () => new BrowserUnavailable({ message: "fullPage must be true or false." }),
            ),
          )

          const shot = yield* pages.screenshot(yield* callingThread, fullPage === true)

          return new McpSchema.CallToolResult({
            content: [
              { type: "image", data: shot.png, mimeType: "image/png" },
              { type: "text", text: `${shot.title || "Untitled"} at ${shot.url}` },
            ],
          })
        }).pipe(Effect.catch(({ message }) => Effect.succeed(failedToolCall(message)))),
    })
  }),
).pipe(Layer.provide(McpServer.McpServer.layer))

export const BrowserMcpTools = Layer.mergeAll(
  McpServer.toolkit(BrowserTools).pipe(Layer.provide(BrowserToolHandlers)),
  ScreenshotBrowser,
)
