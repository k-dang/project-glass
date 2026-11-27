import { burstCounter, Remounting, RendererError, type RendererEvent } from "@glass/contracts"
import { useEffect } from "react"
import { Backend, useBackendRuntime } from "./backend"

export const REMOUNT_LIMIT = 10

const REMOUNT_WINDOW_MS = 5000

const FLUSH_EVERY_MS = 2000

const MAX_PENDING = 100

let pending: Array<RendererEvent> = []

const report = (event: RendererEvent) => {
  if (pending.length < MAX_PENDING) pending.push(event)
}

const remounting = burstCounter(REMOUNT_LIMIT, REMOUNT_WINDOW_MS)

export function useMountWatch(component: string, key: string | null) {
  useEffect(() => {
    if (remounting(`${component} ${key}`, performance.now()))
      report(
        Remounting.make({ component, key, mounts: REMOUNT_LIMIT, windowMs: REMOUNT_WINDOW_MS }),
      )
  }, [component, key])
}

const errorOf = (kind: typeof RendererError.Type.kind, thrown: Error | null, described: string) =>
  RendererError.make({
    kind,
    name: thrown?.name ?? "NotAnError",
    message: thrown?.message ?? described,
    stack: thrown?.stack ?? null,
  })

const onError = (event: ErrorEvent) =>
  report(errorOf("error", event.error instanceof Error ? event.error : null, event.message))

const onRejection = (event: PromiseRejectionEvent) =>
  report(
    errorOf(
      "unhandledrejection",
      event.reason instanceof Error ? event.reason : null,
      String(event.reason),
    ),
  )

export function useRendererEvents() {
  const runtime = useBackendRuntime()

  useEffect(() => {
    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onRejection)

    const flushing = setInterval(() => {
      if (pending.length === 0) return

      const events = pending
      pending = []
      void runtime.runPromiseExit(
        Backend.use((backend) => backend.ReportRendererEvents({ events })),
      )
    }, FLUSH_EVERY_MS)

    return () => {
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onRejection)
      clearInterval(flushing)
    }
  }, [runtime])
}
