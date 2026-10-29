import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

// The shape Agent reviews were saved in before they became one Markdown document. It is spelled
// out here so this migration keeps working as the contracts move on.
const Saved = Schema.fromJsonString(
  Schema.Struct({
    headline: Schema.String,
    summary: Schema.String,
    findings: Schema.Array(
      Schema.Struct({
        rating: Schema.Literals(["blocking", "should-fix", "nit"]),
        title: Schema.String,
        body: Schema.String,
        place: Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("line"),
            path: Schema.String,
            side: Schema.Literals(["old", "new"]),
            line: Schema.Number,
          }),
          Schema.Struct({
            kind: Schema.Literal("file"),
            path: Schema.String,
            lineOutsideDiff: Schema.NullOr(
              Schema.Struct({ side: Schema.Literals(["old", "new"]), line: Schema.Number }),
            ),
          }),
          Schema.Struct({ kind: Schema.Literal("pull-request") }),
        ]),
      }),
    ),
  }),
)

type Finding = (typeof Saved.Type)["findings"][number]

const ratings = { blocking: "Blocking", "should-fix": "Should fix", nit: "Nit" } as const

const placeOf = ({ place }: Finding) => {
  if (place.kind === "pull-request") return null

  const line = place.kind === "line" ? place : place.lineOutsideDiff

  return line === null
    ? `\`${place.path}\``
    : `\`${place.path}:${line.line}\`${line.side === "old" ? " (old)" : ""}`
}

const markdownOf = ({ headline, summary, findings }: typeof Saved.Type) =>
  [
    `**${headline}** ${summary}`,
    ...findings.map((finding) => {
      const place = placeOf(finding)

      return `## ${finding.title}\n\n${ratings[finding.rating]}${place === null ? "" : ` · ${place}`}\n\n${finding.body}`
    }),
  ].join("\n\n")

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{ owner: string; repo: string; number: number; content: string }>`
    SELECT owner, repo, number, content FROM agent_reviews
  `

  // A review that no longer decodes can be written again, so it goes rather than failing startup.
  for (const row of rows) {
    const saved = yield* Schema.decodeUnknownEffect(Saved)(row.content).pipe(Effect.option)
    const where = sql`owner = ${row.owner} AND repo = ${row.repo} AND number = ${row.number}`

    yield* Option.isSome(saved)
      ? sql`UPDATE agent_reviews SET content = ${markdownOf(saved.value)} WHERE ${where}`
      : sql`DELETE FROM agent_reviews WHERE ${where}`
  }

  yield* sql`ALTER TABLE agent_reviews DROP COLUMN folded`
  yield* sql`ALTER TABLE agent_reviews RENAME COLUMN content TO markdown`
})
