import { Effect, Layer, Option, Predicate, Schema, Stream } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { failedToolCall } from "../agentHost/protocol"
import { BrowserPages, BrowserUnavailable } from "../BrowserPages"
import { Threads } from "../Threads"
import { McpCaller } from "./McpCredentials"
import { forThreadsOnThisDevice } from "./toolAudience"

export const callingThreadOnThisDevice = (threads: Threads["Service"]) =>
  Effect.gen(function* () {
    const caller = yield* Effect.serviceOption(McpCaller)

    const threadId =
      Option.isSome(caller) && Predicate.isTagged(caller.value, "Thread")
        ? caller.value.threadId
        : null

    const listed = yield* threads.watch().pipe(Stream.take(1), Stream.runCollect, Effect.orDie)
    const thread = listed.flat().find(({ id }) => id === threadId)

    if (thread === undefined || !Predicate.isTagged(thread.place, "local"))
      return yield* new BrowserUnavailable({
        message: "Only a Thread on this device has a Browser pane its agent can use.",
      })

    return thread.id
  })

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
    const threads = yield* Threads

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

          const threadId = yield* callingThreadOnThisDevice(threads)

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
