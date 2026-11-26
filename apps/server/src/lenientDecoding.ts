import { Effect, type Option, SchemaIssue } from "effect"

const formatIssue = SchemaIssue.makeFormatterDefault()

export const dropMalformed =
  <A>(what: string, fallback: Option.Option<A>) =>
  (issue: SchemaIssue.Issue) =>
    Effect.logWarning(`Dropped a malformed ${what}`, formatIssue(issue)).pipe(Effect.as(fallback))
