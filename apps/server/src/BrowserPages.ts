import { type BrowserPageAnswer, BrowserPageRefused, BrowserPageRequest } from "@glass/contracts"
import { Context, Deferred, Duration, Effect, Exit, Layer, Match, Schema, Stream } from "effect"
import { randomUUID } from "node:crypto"
import type { Browser, Page } from "playwright-core"
import { inboxWaitsOf } from "./inboxWaits"

export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()(
  "BrowserUnavailable",
  { message: Schema.String },
) {}

export const PageLogEntry = Schema.Struct({
  at: Schema.String,
  kind: Schema.Literals(["console error", "console warning", "page error", "request failed"]),
  text: Schema.String,
})

export type PageLogEntry = typeof PageLogEntry.Type

export const ShownPage = Schema.Struct({ url: Schema.String, title: Schema.String })

export type ShownPage = typeof ShownPage.Type

interface Connection {
  readonly browser: Browser
  readonly page: Page
  readonly log: Array<PageLogEntry>
}

const ANSWER_TIMEOUT = Duration.seconds(20)

const MAX_LOG = 200

const MAX_SNAPSHOT_CHARS = 40_000

const ELECTRON_WARNING = "%cElectron Security Warning"

const failure = (cause: unknown, prefix = "") =>
  new BrowserUnavailable({
    message: `${prefix}${cause instanceof Error ? (cause.message.split("\n")[0] ?? cause.message) : String(cause)}`,
  })

const live = ({ browser, page }: Connection) => browser.isConnected() && !page.isClosed()

const logged = (connection: Connection) => {
  const add = (kind: PageLogEntry["kind"], text: string) => {
    connection.log.push({ at: new Date().toISOString(), kind, text })
    connection.log.splice(0, Math.max(0, connection.log.length - MAX_LOG))
  }

  connection.page.on("console", (message) => {
    if (message.text().startsWith(ELECTRON_WARNING)) return

    if (message.type() === "error") add("console error", message.text())
    else if (message.type() === "warning") add("console warning", message.text())
  })
  connection.page.on("pageerror", (error) => add("page error", error.message))
  connection.page.on("requestfailed", (request) =>
    add(
      "request failed",
      `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`,
    ),
  )
  connection.page.on("response", (response) => {
    if (response.status() >= 400)
      add(
        "request failed",
        `${response.request().method()} ${response.url()}: HTTP ${response.status()}`,
      )
  })
}

const shown = async (page: Page): Promise<ShownPage> => ({
  url: page.url(),
  title: await page.title(),
})

export class BrowserPages extends Context.Service<
  BrowserPages,
  {
    readonly requests: Stream.Stream<ReadonlyArray<BrowserPageRequest>>
    readonly answer: (id: string, answer: BrowserPageAnswer) => Effect.Effect<void>
    readonly open: (
      threadId: string,
      url: string | undefined,
    ) => Effect.Effect<ShownPage, BrowserUnavailable>
    readonly read: (
      threadId: string,
    ) => Effect.Effect<ShownPage & { readonly snapshot: string }, BrowserUnavailable>
    readonly screenshot: (
      threadId: string,
      fullPage: boolean,
    ) => Effect.Effect<ShownPage & { readonly png: Uint8Array }, BrowserUnavailable>
    readonly consoleLog: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<PageLogEntry>, BrowserUnavailable>
  }
>()("@glass/server/BrowserPages") {
  static readonly layer = Layer.effect(
    BrowserPages,
    Effect.gen(function* () {
      const waits = yield* inboxWaitsOf<BrowserPageRequest, BrowserPageAnswer>({
        idOf: ({ id }) => id,
        timedOut: BrowserPageRefused.make({
          message:
            "Glass's window didn't open this Thread's Browser pane in time. Glass may be closed.",
        }),
        cancelled: BrowserPageRefused.make({ message: "Glass is shutting down." }),
      })

      const connections = new Map<string, Deferred.Deferred<Connection, BrowserUnavailable>>()
      const browsers = new Set<Browser>()

      yield* Effect.addFinalizer(() =>
        waits
          .cancelAll()
          .pipe(
            Effect.andThen(
              Effect.promise(() =>
                Promise.allSettled([...browsers].map((browser) => browser.close())),
              ),
            ),
          ),
      )

      const endpointFor = (threadId: string) => {
        const request = new BrowserPageRequest({ id: randomUUID(), threadId })

        return waits.wait(request, request.id, ANSWER_TIMEOUT).pipe(
          Effect.orDie,
          Effect.flatMap((answer) =>
            Match.valueTags(answer, {
              BrowserPageReady: ({ endpoint }) => Effect.succeed(endpoint),
              BrowserPageRefused: ({ message }) => Effect.fail(new BrowserUnavailable({ message })),
            }),
          ),
        )
      }

      const connect = (endpoint: string) =>
        Effect.tryPromise({
          try: async () => {
            const { chromium } = await import("playwright-core")
            const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 })
            const page = browser.contexts().flatMap((context) => context.pages())[0]

            if (page === undefined) {
              await browser.close()

              throw new Error("The Browser pane has no page.")
            }

            browsers.add(browser)
            browser.on("disconnected", () => browsers.delete(browser))

            const connection = { browser, page, log: [] }
            logged(connection)

            return connection
          },
          catch: (cause) => failure(cause, "Glass couldn't reach this Thread's Browser pane: "),
        })

      const connected = (threadId: string): Effect.Effect<Connection, BrowserUnavailable> =>
        Effect.suspend(() => {
          const known = connections.get(threadId)

          if (known !== undefined)
            return Deferred.await(known).pipe(
              Effect.exit,
              Effect.flatMap((exit) => {
                if (Exit.isSuccess(exit) && live(exit.value)) return Effect.succeed(exit.value)

                if (connections.get(threadId) === known) connections.delete(threadId)

                return connected(threadId)
              }),
            )

          const opening = Deferred.makeUnsafe<Connection, BrowserUnavailable>()
          connections.set(threadId, opening)

          return endpointFor(threadId).pipe(
            Effect.flatMap(connect),
            Effect.onExit((exit) => {
              if (Exit.isFailure(exit) && connections.get(threadId) === opening)
                connections.delete(threadId)

              return Deferred.done(opening, exit)
            }),
          )
        })

      const onPage = <A>(threadId: string, act: (connection: Connection) => Promise<A>) =>
        connected(threadId).pipe(
          Effect.flatMap((connection) =>
            Effect.tryPromise({ try: () => act(connection), catch: (cause) => failure(cause) }),
          ),
        )

      return BrowserPages.of({
        requests: waits.watch(),
        answer: (id, answer) => waits.resolve(id, answer).pipe(Effect.asVoid),
        open: (threadId, url) =>
          onPage(threadId, async ({ page }) => {
            if (url !== undefined) await page.goto(url, { waitUntil: "load" })

            return shown(page)
          }),
        read: (threadId) =>
          onPage(threadId, async ({ page }) => {
            const snapshot = await page.locator("body").ariaSnapshot()

            return {
              ...(await shown(page)),
              snapshot:
                snapshot.length > MAX_SNAPSHOT_CHARS
                  ? `${snapshot.slice(0, MAX_SNAPSHOT_CHARS)}… (cut short)`
                  : snapshot,
            }
          }),
        screenshot: (threadId, fullPage) =>
          onPage(threadId, async ({ page }) => ({
            png: new Uint8Array(await page.screenshot({ fullPage })),
            ...(await shown(page)),
          })),
        consoleLog: (threadId) => onPage(threadId, ({ log }) => Promise.resolve([...log])),
      })
    }),
  )
}
