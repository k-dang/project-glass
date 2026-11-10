import { Chapter, Tour, type TourDiagram } from "@glass/contracts"
import { Effect, Logger, Schema } from "effect"
import { expect, it } from "vite-plus/test"
import { TourAnswer } from "./tourPrompt"

const target = { path: "greet.ts", side: "new", startLine: 1, endLine: 1 } as const

const chapter = {
  title: "Name the greeting",
  explanation: "Use the supplied name.",
  files: [{ path: target.path, summary: "Builds the greeting." }],
}

const callouts = [{ label: "The name reaches the greeting.", target }]

const answer = { intent: "Greet people by name.", chapters: [chapter], unplacedFiles: [] }

const decode = Schema.decodeUnknownSync(TourAnswer)

const diagram: TourDiagram = {
  nodes: [
    { id: "receive", label: "Receive name", change: "unchanged", target },
    { id: "greet", label: "Build greeting", change: "added", target },
  ],
  edges: [{ from: "receive", to: "greet", change: "added" }],
}

it.each([
  ["empty diagram", { diagram: { nodes: [], edges: [] } }],
  ["malformed Before / after", { beforeAfter: "not an outline" }],
] as const)("omits %s without discarding prose or valid sibling visuals", (_, invalid) => {
  const result = decode({ ...answer, chapters: [{ ...chapter, callouts, ...invalid }] })
  expect(result.chapters).toEqual([{ ...chapter, callouts }])
  expect(Schema.is(Chapter)(result.chapters[0])).toBe(true)
})

it("accepts null callouts quietly and warns readably about malformed ones", () => {
  const logged: Array<unknown> = []
  const logger = Logger.make(({ message }) => logged.push(message))

  const chapters = [
    { ...chapter, callouts: null },
    { ...chapter, callouts: "not a list" },
  ]

  const result = Schema.decodeUnknownEffect(TourAnswer)({ ...answer, chapters }).pipe(
    Effect.provide(Logger.layer([logger])),
    Effect.runSync,
  )

  expect(result.chapters).toEqual([{ ...chapter, callouts: null }, chapter])
  expect(logged).toEqual([["Dropped a malformed Tour visual", "Expected array | null"]])
})

it.each([null, [], [{ caption: "Receive", nodes: null }]])(
  "preserves a static diagram when playback steps are malformed: %j",
  (steps) => {
    const result = decode({ ...answer, chapters: [{ ...chapter, diagram: { ...diagram, steps } }] })
    expect(result.chapters[0]?.diagram).toEqual(diagram)
  },
)

it("still rejects malformed required Chapter content", () => {
  expect(() =>
    decode({ ...answer, chapters: [{ ...chapter, explanation: null, diagram: {} }] }),
  ).toThrow(/explanation/)
})

it("omits a malformed Tour Before / after without discarding its Chapters", () => {
  expect(decode({ ...answer, beforeAfter: { title: "Empty", lines: [] } })).toEqual(answer)
})

it("still asks the agent for the strict output schema", () => {
  const strict = Schema.Struct({
    intent: TourAnswer.fields.intent,
    beforeAfter: Tour.fields.beforeAfter,
    chapters: Schema.Array(Chapter),
    unplacedFiles: TourAnswer.fields.unplacedFiles,
  })

  expect(Schema.toJsonSchemaDocument(TourAnswer)).toEqual(Schema.toJsonSchemaDocument(strict))
})
