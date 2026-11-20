import { assert, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { aliasedAnswers, aliasedLookup } from "./aliasedLookups"

const Titles = aliasedLookup({
  name: "Titles",
  batchSize: 10,
  declarations: (index) => `$number${index}: Int!`,
  selection: (index) => `pullRequest(number: $number${index}) { title }`,
  fragment: "",
  variables: (number: number, index) => [[`number${index}`, number]],
  answer: Schema.Struct({ title: Schema.String }),
  decode: ({ title }, number) => `#${number} ${title}`,
})

it("answers null for a lookup GitHub can't find or forbids, and decodes the rest", () => {
  assert.deepStrictEqual(
    aliasedAnswers(Titles, [1, 2, 3], {
      data: { lookup0: { title: "Greet" }, lookup1: null, lookup2: null },
      errors: [
        { type: "NOT_FOUND", message: "Not found", path: ["lookup1"] },
        { type: "FORBIDDEN", message: "SAML", path: ["lookup2"] },
      ],
    }),
    Result.succeed(["#1 Greet", null, null]),
  )
})

it("fails the batch on any other error, or when GitHub answers without data", () => {
  assert.deepStrictEqual(
    aliasedAnswers(Titles, [1], {
      data: { lookup0: null },
      errors: [{ message: "Timeout", path: ["lookup0"] }],
    }),
    Result.fail("Timeout"),
  )
  assert.deepStrictEqual(
    aliasedAnswers(Titles, [1], {}),
    Result.fail("GraphQL Titles answered without data"),
  )
})
