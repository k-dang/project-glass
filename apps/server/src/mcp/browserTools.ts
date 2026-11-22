import { Effect, Layer, Option, Predicate, Schema } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { failedToolCall } from "../agentHost/protocol"
import { BrowserPages, BrowserUnavailable } from "../BrowserPages"
import { McpCaller } from "./McpCredentials"
import { forThreadsOnThisDevice } from "./toolAudience"

export const callingThread = Effect.serviceOption(McpCaller).pipe(
  Effect.flatMap((caller) =>
    Option.isSome(caller) && Predicate.isTagged(caller.value, "Thread")
      ? Effect.succeed(caller.value.threadId)
      : Effect.fail(
          new BrowserUnavailable({ message: "Only a Thread's agent has a Browser pane to use." }),
        ),
  ),
)

const ScreenshotInput = Schema.Struct({ fullPage: Schema.optional(Schema.Boolean) })

const decodeScreenshotInput = Schema.decodeUnknownEffect(ScreenshotInput)

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

export const ScreenshotBrowser = Layer.effectDiscard(
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

          const threadId = yield* callingThread

          const shot = yield* pages.use(threadId, async (page) => ({
            png: await page.screenshot({ fullPage: fullPage === true }),
            url: page.url(),
            title: await page.title(),
          }))

          return new McpSchema.CallToolResult({
            content: [
              { type: "image", data: new Uint8Array(shot.png), mimeType: "image/png" },
              { type: "text", text: `${shot.title || "Untitled"} at ${shot.url}` },
            ],
          })
        }).pipe(Effect.catch(({ message }) => Effect.succeed(failedToolCall(message)))),
    })
  }),
).pipe(Layer.provide(McpServer.McpServer.layer))
