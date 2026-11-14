import { flow, Record, Result, Schema } from "effect"
import * as z from "zod"

export interface ToolReply {
  readonly accepted: boolean
  readonly text: string
}

/**
 * Generated JSON Schema drops some checks, so Claude Code and pi only screen a tool's arguments
 * with it, and the tool decodes them with the schema Glass reads its calls back with.
 */
export const toolParameters = (
  fields: Record.ReadonlyRecord<string, readonly [field: Schema.Top, description: string]>,
) => {
  const properties = Record.map(fields, ([field, description]) => ({
    ...Schema.toJsonSchemaDocument(field).schema,
    description,
  }))

  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  } as const
}

export const claudeToolInput = (parameters: ReturnType<typeof toolParameters>) =>
  Record.map(parameters.properties, (property) => z.fromJSONSchema(property))

export const replyTo = <A>(schema: Schema.ConstraintDecoder<A>, reply: (value: A) => ToolReply) =>
  flow(
    Schema.decodeUnknownResult(schema, { errors: "all" }),
    Result.match({
      onFailure: (error): ToolReply => ({ accepted: false, text: error.message }),
      onSuccess: reply,
    }),
  )
