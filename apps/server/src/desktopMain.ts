import { BACKEND_READY, STOP_BACKEND } from "@glass/contracts"
import { Effect } from "effect"

type ParentMessageListener = (event: { readonly data: unknown }) => void

interface ParentPort {
  readonly postMessage: (message: typeof BACKEND_READY) => void
  readonly on: (event: "message", listener: ParentMessageListener) => void
  readonly off: (event: "message", listener: ParentMessageListener) => void
}

const { parentPort }: { readonly pid: number; readonly parentPort?: ParentPort } = process

export const reportReady = Effect.sync(() =>
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Electron's ParentPort takes no target origin.
  parentPort?.postMessage(BACKEND_READY),
)

const stopAsked = (port: ParentPort) =>
  Effect.callback<void>((resume) => {
    const onMessage: ParentMessageListener = (event) => {
      if (event.data === STOP_BACKEND) resume(Effect.void)
    }

    port.on("message", onMessage)

    return Effect.sync(() => port.off("message", onMessage))
  })

export const untilDesktopStops = <A, E, R>(main: Effect.Effect<A, E, R>) =>
  parentPort === undefined
    ? main
    : Effect.raceFirst(main, stopAsked(parentPort).pipe(Effect.andThen(Effect.interrupt)))
