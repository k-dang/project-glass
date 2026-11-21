import { PagePart } from "@glass/contracts"
import { Schema } from "effect"

const PageRect = Schema.Struct({
  top: Schema.Number,
  left: Schema.Number,
  bottom: Schema.Number,
  right: Schema.Number,
})

export type PageRect = typeof PageRect.Type

const PageEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("part"), part: PagePart, rect: PageRect }),
  Schema.Struct({ type: Schema.Literal("open"), id: Schema.String, rect: PageRect }),
  Schema.Struct({ type: Schema.Literal("rect"), rect: PageRect }),
  Schema.Struct({ type: Schema.Literal("escape") }),
])

export type PageEvent = typeof PageEvent.Type

export const FromPage = Schema.Struct({ glassPageEvent: PageEvent })

export interface PageState {
  readonly pick: boolean
  readonly notes: ReadonlyArray<{ readonly id: string; readonly part: PagePart }>
  readonly active:
    | { readonly type: "draft" }
    | { readonly type: "note"; readonly id: string }
    | null
}
