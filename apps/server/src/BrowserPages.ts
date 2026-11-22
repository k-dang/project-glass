import { type BrowserPageAnswer, BrowserPageRequest } from "@glass/contracts"
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Match,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { randomUUID } from "node:crypto"
import { type Browser, chromium, type Page } from "playwright-core"

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

interface Pending {
  readonly request: BrowserPageRequest
  readonly answered: Deferred.Deferred<BrowserPageAnswer>
}

const ANSWER_TIMEOUT = Duration.seconds(20)

const MAX_LOG = 200

const ELECTRON_WARNING = "%cElectron Security Warning"

const firstLine = (cause: Error) => cause.message.split("\n")[0] ?? cause.message

const logged = (connection: Pick<Connection, "page" | "log">) => {
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
      const pending = yield* SubscriptionRef.make<ReadonlyArray<Pending>>([])
      const connections = new Map<string, Connection>()
      const connecting = yield* Semaphore.make(1)

      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.allSettled([...connections.values()].map(({ browser }) => browser.close())),
        ),
      )

      const endpointFor = (threadId: string) =>
        Effect.gen(function* () {
          const request = new BrowserPageRequest({ id: randomUUID(), threadId })
          const answered = yield* Deferred.make<BrowserPageAnswer>()

          yield* Effect.acquireRelease(
            SubscriptionRef.update(pending, (items) => [...items, { request, answered }]),
            () =>
              SubscriptionRef.update(pending, (items) =>
                items.filter((item) => item.request !== request),
              ),
          )

          const answer = yield* Deferred.await(answered).pipe(
            Effect.timeoutOrElse({
              duration: ANSWER_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new BrowserUnavailable({
                    message:
                      "Glass's window didn't open this Thread's Browser pane in time. Glass may be closed.",
                  }),
                ),
            }),
          )

          return yield* Match.valueTags(answer, {
            BrowserPageReady: ({ endpoint }) => Effect.succeed(endpoint),
            BrowserPageRefused: ({ message }) => Effect.fail(new BrowserUnavailable({ message })),
          })
        }).pipe(Effect.scoped)

      const connect = (threadId: string, endpoint: string) =>
        Effect.tryPromise({
          try: async () => {
            const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 })
            const page = browser.contexts().flatMap((context) => context.pages())[0]

            if (page === undefined) {
              await browser.close()

              throw new Error("The Browser pane has no page.")
            }

            const connection = { browser, page, log: [] }
            logged(connection)
            browser.on("disconnected", () => {
              if (connections.get(threadId) === connection) connections.delete(threadId)
            })
            connections.set(threadId, connection)

            return connection
          },
          catch: (cause) =>
            new BrowserUnavailable({
              message: `Glass couldn't reach this Thread's Browser pane: ${cause instanceof Error ? firstLine(cause) : String(cause)}`,
            }),
        })

      const connected = (threadId: string) =>
        connecting.withPermits(1)(
          Effect.suspend(() => {
            const known = connections.get(threadId)

            if (known !== undefined && known.browser.isConnected() && !known.page.isClosed())
              return Effect.succeed(known)

            return endpointFor(threadId).pipe(
              Effect.flatMap((endpoint) => connect(threadId, endpoint)),
            )
          }),
        )

      return BrowserPages.of({
        requests: SubscriptionRef.changes(pending).pipe(
          Stream.map((items) => items.map(({ request }) => request)),
        ),
        answer: (id, answer) =>
          SubscriptionRef.get(pending).pipe(
            Effect.flatMap((items) => {
              const found = items.find(({ request }) => request.id === id)

              return found === undefined
                ? Effect.void
                : Deferred.succeed(found.answered, answer).pipe(Effect.asVoid)
            }),
          ),
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
