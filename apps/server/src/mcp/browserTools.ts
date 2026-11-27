import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai"
import { failedToolCall } from "../agentHost/protocol"
import {
  BrowserPages,
  type BrowserTakenOver,
  BrowserUnavailable,
  type PageAction,
  PageLogEntry,
  ShownPage,
} from "../BrowserPages"
import { acting, GlassToolFailure, readOnly } from "./glassTools"
import { callingThreadId } from "./McpCredentials"
import { forThreadsOnThisDevice } from "./toolAudience"

const callingThread = callingThreadId.pipe(
  Effect.flatMap(
    Option.match({
      onNone: () =>
        Effect.fail(
          new BrowserUnavailable({ message: "Only a Thread's agent has a Browser pane to use." }),
        ),
      onSome: Effect.succeed,
    }),
  ),
)

const readsOnly = readOnly.pipe(Context.merge(forThreadsOnThisDevice))

const acts = acting.pipe(Context.merge(forThreadsOnThisDevice))

const TAKING_OVER =
  "When the user clicks or types in the page, they take over the browser: open_browser and act_in_browser fail until they hand it back or send their next message."

const OpenBrowser = Tool.make("open_browser", {
  description: `Opens a page in your Thread's Browser pane, the browser the user sees beside your Thread, and waits for it to load. Pass a full http or https address, such as your dev server's http://localhost:3000/. Without one, it opens the pane on the page it last showed. Returns the page's address and title. Then read_browser lists what's on it, act_in_browser clicks and types in it, screenshot_browser shows it, and browser_console lists its errors. ${TAKING_OVER}`,
  parameters: Schema.Struct({
    url: Schema.optional(
      Schema.Trimmed.check(Schema.isPattern(/^https?:\/\//i)).annotate({
        description: "The http or https address to open.",
      }),
    ),
  }),
  success: ShownPage,
  failure: GlassToolFailure,
}).annotateMerge(acts)

const ActInBrowser = Tool.make("act_in_browser", {
  description: `Clicks, types into, presses a key on, or scrolls to an element of the page in your Thread's Browser pane, named by its ref from read_browser's snapshot, such as e12. type replaces the field's text with text. press takes a key such as Enter, Tab or ArrowDown, or a combination such as Control+A. scroll brings the element into view. Returns the page's address and title afterwards; read_browser again to see what changed. ${TAKING_OVER}`,
  parameters: Schema.Struct({
    action: Schema.Literals(["click", "type", "press", "scroll"]).annotate({
      description: "What to do to the element.",
    }),
    ref: Schema.String.annotate({
      description: "The element's ref from read_browser's snapshot, such as e12.",
    }),
    text: Schema.optional(
      Schema.String.annotate({ description: "For type: the text the field should hold." }),
    ),
    key: Schema.optional(
      Schema.String.annotate({ description: "For press: the key, such as Enter or Control+A." }),
    ),
  }),
  success: ShownPage,
  failure: GlassToolFailure,
}).annotateMerge(acts)

const ReadBrowser = Tool.make("read_browser", {
  description:
    "Reads the page in your Thread's Browser pane: its address, title, and an accessibility snapshot of what's on it, as roles, names and text, each element with a ref act_in_browser takes. open_browser opens a page first.",
  success: Schema.Struct({ ...ShownPage.fields, snapshot: Schema.String }),
  failure: GlassToolFailure,
}).annotateMerge(readsOnly)

const BrowserConsole = Tool.make("browser_console", {
  description:
    "Lists the console errors and warnings, uncaught page errors, and failed or HTTP 4xx/5xx requests of the page in your Thread's Browser pane since your browser tools last connected to it, oldest first.",
  success: Schema.Struct({ entries: Schema.Array(PageLogEntry) }),
  failure: GlassToolFailure,
}).annotateMerge(readsOnly)

const BrowserTools = Toolkit.make(OpenBrowser, ActInBrowser, ReadBrowser, BrowserConsole)

const TOOK_OVER =
  "The user took over the browser, so open_browser and act_in_browser fail until they hand it back or send their next message. read_browser, screenshot_browser and browser_console still work."

const toolFailure = (error: BrowserUnavailable | BrowserTakenOver) =>
  new GlassToolFailure({
    message: Predicate.isTagged(error, "BrowserTakenOver") ? TOOK_OVER : error.message,
  })

const pageActionOf = (
  input: Tool.Parameters<typeof ActInBrowser>,
): Effect.Effect<PageAction, GlassToolFailure> => {
  const { action, ref, text, key } = input

  switch (action) {
    case "type":
      return text === undefined
        ? Effect.fail(new GlassToolFailure({ message: "type needs the text to type." }))
        : Effect.succeed({ action, ref, text })
    case "press":
      return key === undefined
        ? Effect.fail(new GlassToolFailure({ message: "press needs the key to press." }))
        : Effect.succeed({ action, ref, key })
    default:
      return Effect.succeed({ action, ref })
  }
}

const BrowserToolHandlers = BrowserTools.toLayer(
  Effect.gen(function* () {
    const pages = yield* BrowserPages

    return BrowserTools.of({
      open_browser: ({ url }) =>
        callingThread.pipe(
          Effect.flatMap((threadId) => pages.open(threadId, url)),
          Effect.mapError(toolFailure),
        ),
      act_in_browser: (input) =>
        pageActionOf(input).pipe(
          Effect.flatMap((pageAction) =>
            callingThread.pipe(
              Effect.flatMap((threadId) => pages.act(threadId, pageAction)),
              Effect.mapError(toolFailure),
            ),
          ),
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
