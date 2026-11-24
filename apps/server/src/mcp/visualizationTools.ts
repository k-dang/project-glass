import { SHOW_VISUALIZATION_TOOL, VisualizationShown, VisualizationTitle } from "@glass/contracts"
import { Effect, Match, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { PAGE_GUIDE } from "../visualizationPage"
import { ShownBy, Visualizations, VisualizationSource } from "../Visualizations"
import { GlassToolFailure, readOnly } from "./glassTools"
import { McpCaller } from "./McpCredentials"

const MAX_INLINE_CHARS = 512_000

const ShowVisualization = Tool.make(SHOW_VISUALIZATION_TOOL, {
  description: `Shows a finished HTML page, such as a chart, diagram, table, or mockup, inline in your Thread above your reply. Pass exactly one of html or path. Use it when a picture answers better than text, such as data with a trend or comparison, or when the user asks to see something. Don't describe or restate the page in your reply. ${PAGE_GUIDE}`,
  parameters: Schema.Struct({
    title: VisualizationTitle.annotate({ description: "A short name for the page." }),
    html: Schema.optional(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_INLINE_CHARS)).annotate({
        description: "The page's HTML, starting with <!doctype html>.",
      }),
    ),
    path: Schema.optional(
      Schema.String.check(Schema.isMinLength(1)).annotate({
        description:
          "An .html file in your Thread's folder. Glass shows the file as it is now; call again after you change it.",
      }),
    ),
  }),
  success: VisualizationShown,
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

export const VisualizationTools = Toolkit.make(ShowVisualization)

const SHOWN =
  "The user sees this page above your reply. Don't mention or describe it; reply with only what it doesn't already say."

const shownByCaller = Effect.flatMap(McpCaller.current, (caller) =>
  Match.valueTags(caller, {
    Thread: ({ threadId }) => Effect.succeed(ShownBy.Thread({ threadId })),
    GlobalChat: ({ sessionId }) => Effect.succeed(ShownBy.GlobalChat({ sessionId })),
    OutsideAgent: () =>
      Effect.fail(
        new GlassToolFailure({
          message: "Glass shows Visualizations only in its own Threads and Global chat.",
        }),
      ),
  }),
)

export const VisualizationToolHandlers = VisualizationTools.toLayer(
  Effect.gen(function* () {
    const visualizations = yield* Visualizations

    return VisualizationTools.of({
      show_visualization: ({ title, html, path }) =>
        Effect.gen(function* () {
          const by = yield* shownByCaller

          const source =
            html !== undefined && path === undefined
              ? VisualizationSource.Html({ html })
              : path !== undefined && html === undefined
                ? VisualizationSource.File({ path })
                : yield* new GlassToolFailure({ message: "Pass exactly one of html or path." })

          const id = yield* visualizations
            .show(by, source)
            .pipe(Effect.mapError(({ message }) => new GlassToolFailure({ message })))

          return { visualization: { id, title }, message: SHOWN }
        }),
    })
  }),
)
