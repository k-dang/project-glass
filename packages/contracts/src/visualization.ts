import { Option, Schema } from "effect"
import type { ToolCallPart } from "./thread"

export const SHOW_VISUALIZATION_TOOL = "show_visualization"

export const VISUALIZATIONS_PATH = "/visualizations"

export const VisualizationTitle = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200))

export const ShownVisualization = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
})

export type ShownVisualization = typeof ShownVisualization.Type

export const VisualizationShown = Schema.Struct({
  visualization: ShownVisualization,
  message: Schema.String,
})

const decodeShown = Schema.decodeUnknownOption(Schema.fromJsonString(VisualizationShown))

export const shownVisualizationOf = (call: typeof ToolCallPart.Type): ShownVisualization | null =>
  call.name === SHOW_VISUALIZATION_TOOL && call.status === "done" && call.output !== null
    ? Option.getOrNull(Option.map(decodeShown(call.output), ({ visualization }) => visualization))
    : null

export const VISUALIZATION_THEME_PARAM = "glass-theme"

export const VISUALIZATION_THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--added",
  "--modified",
  "--deleted",
  "--radius",
  "--font-ui",
  "--font-code",
]

export const VisualizationSized = Schema.TaggedStruct("VisualizationSized", {
  height: Schema.Finite,
})

export const VisualizationLinkOpened = Schema.TaggedStruct("VisualizationLinkOpened", {
  url: Schema.String,
})

export const VisualizationMessage = Schema.Union([VisualizationSized, VisualizationLinkOpened])
