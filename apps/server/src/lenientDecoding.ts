import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect"

const formatIssue = SchemaIssue.makeFormatterDefault()

/**
 * A `Schema.catchDecoding` handler that logs a malformed part of an agent's answer and decodes it
 * as `fallback`, so one bad part never fails the whole answer.
 */
export const dropMalformed =
  <A>(what: string, fallback: Option.Option<A>) =>
  (issue: SchemaIssue.Issue) =>
    Effect.logWarning(`Dropped a malformed ${what}`, formatIssue(issue)).pipe(Effect.as(fallback))

export const nullWhenMalformed = <S extends Schema.Constraint>(what: string, schema: S) =>
  Schema.catchDecoding<Schema.NullOr<S>>(dropMalformed(what, Option.some(null)))(
    Schema.NullOr(schema),
  ).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null)))

export const keepWellFormed = <S extends Schema.Constraint>(what: string, item: S) =>
  Schema.Array(
    Schema.catchDecoding<Schema.NullOr<S>>(dropMalformed(what, Option.some(null)))(
      Schema.NullOr(item),
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(item)),
      SchemaTransformation.transform<ReadonlyArray<S["Type"]>, ReadonlyArray<S["Type"] | null>>({
        decode: (items) => items.filter((entry): entry is S["Type"] => entry !== null),
        encode: (items) => items,
      }),
    ),
    Schema.catchDecoding(dropMalformed(`${what} list`, Option.some([]))),
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  )
