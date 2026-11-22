import {
  type BrowserPageAnswer,
  BrowserControl,
  BrowserPageRefused,
  BrowserPageRequest,
} from "@glass/contracts"
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { randomUUID } from "node:crypto"
import type { Browser, Locator, Page } from "playwright-core"
import { inboxWaitsOf } from "./inboxWaits"

export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()(
  "BrowserUnavailable",
  { message: Schema.String },
) {}

export class BrowserTakenOver extends Schema.TaggedError<BrowserTakenOver>()(
  "BrowserTakenOver",
  {},
) {}

export const PageLogEntry = Schema.Struct({
  at: Schema.String,
  kind: Schema.Literals(["console error", "console warning", "page error", "request failed"]),
  text: Schema.String,
})

export type PageLogEntry = typeof PageLogEntry.Type

export const ShownPage = Schema.Struct({ url: Schema.String, title: Schema.String })

export type ShownPage = typeof ShownPage.Type

export type PageAction =
  | { readonly action: "click"; readonly ref: string }
  | { readonly action: "type"; readonly ref: string; readonly text: string }
  | { readonly action: "press"; readonly ref: string; readonly key: string }
  | { readonly action: "scroll"; readonly ref: string }

interface Control {
  readonly using: number
  readonly tookOver: boolean
}

const IDLE: Control = { using: 0, tookOver: false }

const withControl = (
  all: ReadonlyMap<string, Control>,
  threadId: string,
  control: Control,
): ReadonlyMap<string, Control> => {
  const updated = new Map(all)

  if (control.using === 0 && !control.tookOver) updated.delete(threadId)
  else updated.set(threadId, control)

  return updated
}

interface Connection {
  readonly browser: Browser
  readonly page: Page
  readonly log: Array<PageLogEntry>
}

const ANSWER_TIMEOUT = Duration.seconds(20)

const MAX_LOG = 200

const MAX_SNAPSHOT_CHARS = 40_000

const ACT_TIMEOUT_MS = 5_000

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

const SAME_SITE_AS_PAGE = `(() => {
  const own = new URL(origin)
  return Array.from(location.ancestorOrigins, (ancestor) => new URL(ancestor)).every(
    (ancestor) => ancestor.protocol === own.protocol && ancestor.hostname === own.hostname,
  )
})()`

const typeable = async (element: Locator, options: { timeout: number; signal: AbortSignal }) => {
  // WARNING: The relay types through Electron's input for the page, which doesn't reach a frame from another site.
  if ((await element.evaluate(SAME_SITE_AS_PAGE, undefined, options)) !== true)
    throw new Error(
      "act_in_browser can't type or press keys in a frame from another site; click works there.",
    )
}

const perform = async (page: Page, action: PageAction, signal: AbortSignal) => {
  const element = page.locator(`aria-ref=${action.ref}`)
  const options = { timeout: ACT_TIMEOUT_MS, signal }

  switch (action.action) {
    case "click":
      return element.click(options)
    case "type":
      await typeable(element, options)

      return element.fill(action.text, options)
    case "press":
      await typeable(element, options)

      return element.press(action.key, options)
    case "scroll":
      return element.scrollIntoViewIfNeeded(options)
  }
}

export class BrowserPages extends Context.Service<
  BrowserPages,
  {
    readonly requests: Stream.Stream<ReadonlyArray<BrowserPageRequest>>
    readonly answer: (id: string, answer: BrowserPageAnswer) => Effect.Effect<void>
    readonly control: Stream.Stream<ReadonlyArray<BrowserControl>>
    readonly takeOver: (threadId: string) => Effect.Effect<void>
    readonly handBack: (threadId: string) => Effect.Effect<boolean>
    readonly open: (
      threadId: string,
      url: string | undefined,
    ) => Effect.Effect<ShownPage, BrowserUnavailable | BrowserTakenOver>
    readonly act: (
      threadId: string,
      action: PageAction,
    ) => Effect.Effect<ShownPage, BrowserUnavailable | BrowserTakenOver>
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

      const connections = new Map<
        string,
        {
          readonly endpoint: string
          readonly ready: Deferred.Deferred<Connection, BrowserUnavailable>
        }
      >()

      const browsers = new Set<Browser>()

      const controls = yield* SubscriptionRef.make<ReadonlyMap<string, Control>>(new Map())

      const change = (threadId: string, next: (control: Control) => Control) =>
        SubscriptionRef.updateSome(controls, (all) => {
          const current = all.get(threadId) ?? IDLE
          const changed = next(current)

          return changed.using === current.using && changed.tookOver === current.tookOver
            ? Option.none()
            : Option.some(withControl(all, threadId, changed))
        })

      const claim = (threadId: string, acts: boolean) =>
        SubscriptionRef.modifySome(controls, (all) => {
          const current = all.get(threadId) ?? IDLE

          return acts && current.tookOver
            ? ([false, Option.none()] as const)
            : ([
                true,
                Option.some(withControl(all, threadId, { ...current, using: current.using + 1 })),
              ] as const)
        })

      const reading = (threadId: string) => claim(threadId, false).pipe(Effect.asVoid)

      const acting = (threadId: string) =>
        claim(threadId, true).pipe(
          Effect.filterOrFail(
            (claimed) => claimed,
            () => new BrowserTakenOver(),
          ),
          Effect.asVoid,
        )

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

      const endpointFor = (threadId: string, restoreLastPage: boolean) => {
        const request = new BrowserPageRequest({ id: randomUUID(), threadId, restoreLastPage })

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

      const connectionTo = (
        threadId: string,
        endpoint: string,
      ): Effect.Effect<Connection, BrowserUnavailable> =>
        Effect.suspend(() => {
          const known = connections.get(threadId)

          if (known?.endpoint === endpoint)
            return Deferred.await(known.ready).pipe(
              Effect.exit,
              Effect.flatMap((exit) => {
                if (Exit.isSuccess(exit) && live(exit.value)) return Effect.succeed(exit.value)

                if (connections.get(threadId) === known) connections.delete(threadId)

                return connectionTo(threadId, endpoint)
              }),
            )

          const ready = Deferred.makeUnsafe<Connection, BrowserUnavailable>()
          const opening = { endpoint, ready }
          connections.set(threadId, opening)

          return connect(endpoint).pipe(
            Effect.onExit((exit) => {
              if (Exit.isFailure(exit) && connections.get(threadId) === opening)
                connections.delete(threadId)

              return Deferred.done(ready, exit)
            }),
          )
        })

      // WARNING: Each call asks the window again, which holds the page for the agent's running Turn even when the connection outlived an earlier Turn.
      const connected = (threadId: string, restoreLastPage: boolean) =>
        endpointFor(threadId, restoreLastPage).pipe(
          Effect.flatMap((endpoint) => connectionTo(threadId, endpoint)),
        )

      const onPage = <A, E>(
        threadId: string,
        claimed: Effect.Effect<void, E>,
        use: (connection: Connection, signal: AbortSignal) => Promise<A>,
        restoreLastPage = true,
      ) =>
        Effect.acquireUseRelease(
          claimed,
          () =>
            connected(threadId, restoreLastPage).pipe(
              Effect.flatMap((connection) =>
                Effect.tryPromise({
                  try: (signal) => use(connection, signal),
                  catch: (cause) => failure(cause),
                }),
              ),
            ),
          () => change(threadId, (control) => ({ ...control, using: control.using - 1 })),
        )

      const untilTakenOver = (threadId: string) =>
        SubscriptionRef.changes(controls).pipe(
          Stream.filter((all) => all.get(threadId)?.tookOver === true),
          Stream.runHead,
          Effect.andThen(Effect.fail(new BrowserTakenOver())),
        )

      const actOnPage = <A>(
        threadId: string,
        use: (connection: Connection, signal: AbortSignal) => Promise<A>,
        restoreLastPage = true,
      ) =>
        onPage(threadId, acting(threadId), use, restoreLastPage).pipe(
          Effect.raceFirst(untilTakenOver(threadId)),
        )

      return BrowserPages.of({
        requests: waits.watch(),
        answer: (id, answer) => waits.resolve(id, answer).pipe(Effect.asVoid),
        control: SubscriptionRef.changes(controls).pipe(
          Stream.map((all) =>
            [...all].map(
              ([threadId, { using, tookOver }]) =>
                new BrowserControl({ threadId, agentUsing: using > 0, userTookOver: tookOver }),
            ),
          ),
        ),
        takeOver: (threadId) => change(threadId, (control) => ({ ...control, tookOver: true })),
        handBack: (threadId) =>
          SubscriptionRef.modifySome(controls, (all) => {
            const current = all.get(threadId) ?? IDLE

            return current.tookOver
              ? ([
                  true,
                  Option.some(withControl(all, threadId, { ...current, tookOver: false })),
                ] as const)
              : ([false, Option.none()] as const)
          }),
        open: (threadId, url) =>
          actOnPage(
            threadId,
            async ({ page }, signal) => {
              if (url !== undefined) await page.goto(url, { waitUntil: "load", signal })

              return shown(page)
            },
            url === undefined,
          ),
        act: (threadId, action) =>
          actOnPage(threadId, async ({ page }, signal) => {
            await perform(page, action, signal)

            return shown(page)
          }),
        read: (threadId) =>
          onPage(threadId, reading(threadId), async ({ page }) => {
            const snapshot = await page.ariaSnapshot({ mode: "ai" })

            return {
              ...(await shown(page)),
              snapshot:
                snapshot.length > MAX_SNAPSHOT_CHARS
                  ? `${snapshot.slice(0, MAX_SNAPSHOT_CHARS)}… (cut short)`
                  : snapshot,
            }
          }),
        screenshot: (threadId, fullPage) =>
          onPage(threadId, reading(threadId), async ({ page }) => ({
            png: new Uint8Array(await page.screenshot({ fullPage })),
            ...(await shown(page)),
          })),
        consoleLog: (threadId) =>
          onPage(threadId, reading(threadId), ({ log }) => Promise.resolve([...log])),
      })
    }),
  )
}
