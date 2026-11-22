import { type BrowserPageAnswer, BrowserPageRefused, BrowserPageRequest } from "@glass/contracts"
import { Context, Duration, Effect, Layer, Match, Schema, Semaphore, Stream } from "effect"
import { randomUUID } from "node:crypto"
import type { Browser, Page } from "playwright-core"
import { inboxWaitsOf } from "./inboxWaits"

export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()(
  "BrowserUnavailable",
  { message: Schema.String },
) {}

export interface PageLogEntry {
  readonly at: string
  readonly kind: "console error" | "console warning" | "page error" | "request failed"
  readonly text: string
}

interface Connection {
  readonly browser: Browser
  readonly page: Page
  readonly log: Array<PageLogEntry>
}

const ANSWER_TIMEOUT = Duration.seconds(20)

const MAX_LOG = 200

const ELECTRON_WARNING = "%cElectron Security Warning"

const firstLine = (cause: Error) => cause.message.split("\n")[0] ?? cause.message

const live = (connection: Connection | undefined): connection is Connection =>
  connection !== undefined && connection.browser.isConnected() && !connection.page.isClosed()

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

export class BrowserPages extends Context.Service<
  BrowserPages,
  {
    readonly requests: Stream.Stream<ReadonlyArray<BrowserPageRequest>>
    readonly answer: (id: string, answer: BrowserPageAnswer) => Effect.Effect<void>
    readonly use: <A>(
      threadId: string,
      act: (page: Page, log: ReadonlyArray<PageLogEntry>) => Promise<A>,
    ) => Effect.Effect<A, BrowserUnavailable>
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

      const connections = new Map<string, Connection>()
      const connecting = yield* Semaphore.make(1)

      yield* Effect.addFinalizer(() =>
        waits
          .cancelAll()
          .pipe(
            Effect.andThen(
              Effect.promise(() =>
                Promise.allSettled([...connections.values()].map(({ browser }) => browser.close())),
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

      const connect = (threadId: string, endpoint: string) =>
        Effect.tryPromise({
          try: async () => {
            const { chromium } = await import("playwright-core")
            const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 })
            const page = browser.contexts().flatMap((context) => context.pages())[0]

            if (page === undefined) {
              await browser.close()

              throw new Error("The Browser pane has no page.")
            }

            const connection = { browser, page, log: [] }
            logged(connection)
            connections.set(threadId, connection)

            return connection
          },
          catch: (cause) =>
            new BrowserUnavailable({
              message: `Glass couldn't reach this Thread's Browser pane: ${cause instanceof Error ? firstLine(cause) : String(cause)}`,
            }),
        })

      const connected = (threadId: string) => {
        const known = connections.get(threadId)

        if (live(known)) return Effect.succeed(known)

        return connecting.withPermits(1)(
          Effect.suspend(() => {
            const settled = connections.get(threadId)

            return live(settled)
              ? Effect.succeed(settled)
              : endpointFor(threadId).pipe(
                  Effect.flatMap((endpoint) => connect(threadId, endpoint)),
                )
          }),
        )
      }

      return BrowserPages.of({
        requests: waits.watch(),
        answer: (id, answer) => waits.resolve(id, answer).pipe(Effect.asVoid),
        use: (threadId, act) =>
          connected(threadId).pipe(
            Effect.flatMap(({ page, log }) =>
              Effect.tryPromise({
                try: () => act(page, log),
                catch: (cause) =>
                  new BrowserUnavailable({
                    message: cause instanceof Error ? firstLine(cause) : String(cause),
                  }),
              }),
            ),
          ),
      })
    }),
  )
}
