import type { RendererEvent } from "@glass/contracts"
import { Effect, Match } from "effect"

const logOf = (event: RendererEvent) =>
  Match.valueTags(event, {
    Remounting: (remounting) =>
      Effect.logWarning("A renderer view keeps remounting").pipe(
        Effect.annotateLogs({
          event: "Remounting",
          component: remounting.component,
          key: remounting.key,
          mounts: remounting.mounts,
          window_ms: remounting.windowMs,
        }),
      ),
    RendererError: (error) =>
      Effect.logError("The renderer threw").pipe(
        Effect.annotateLogs({
          event: "RendererError",
          kind: error.kind,
          error: { tag: error.name, message: error.message },
          stack: error.stack,
        }),
      ),
  })

export const reportRendererEvents = (events: ReadonlyArray<RendererEvent>) =>
  Effect.forEach(
    events,
    (event) => logOf(event).pipe(Effect.annotateLogs({ source: "renderer" })),
    {
      discard: true,
    },
  )
