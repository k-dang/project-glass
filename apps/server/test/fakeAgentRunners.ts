import { Effect, Layer, Schema } from "effect"
import { basename } from "node:path"
import { AgentRunners } from "../src/agentRunners"
import { AgentReviewAnswer } from "../src/agentReviewPrompt"
import { AskAgentAnswer } from "../src/askPrompt"
import type { TourAnswer } from "../src/tourPrompt"

const chapterSize = 2

const material = Schema.fromJsonString(
  Schema.Struct({
    title: Schema.String,
    files: Schema.Array(Schema.Struct({ path: Schema.String })),
  }),
)

const decodeMaterial = (prompt: string) =>
  Schema.decodeUnknownSync(material)(prompt.slice(prompt.indexOf("{")))

/** Pairs the files into Chapters, leaving the last for Everything else once there are three. */
const syntheticTour = (prompt: string): TourAnswer => {
  const { title, files } = decodeMaterial(prompt)
  const paths = files.map((file) => file.path)
  const placed = paths.length > chapterSize ? paths.slice(0, -1) : paths

  const chapters = Array.from({ length: Math.ceil(placed.length / chapterSize) }, (_, index) => {
    const chapterPaths = placed.slice(index * chapterSize, (index + 1) * chapterSize)

    return {
      title: `Synthetic Chapter ${index + 1}`,
      explanation: `A fake Tour runner wrote this without a model. It covers ${chapterPaths
        .map((path) => `\`${path}\``)
        .join(" and ")}, in the order the PR lists them.`,
      files: chapterPaths.map((path) => ({
        path,
        summary: `Synthetic summary of ${basename(path)}.`,
      })),
    }
  })

  return {
    intent: `Synthetic Tour of "${title}", written without a model.`,
    chapters,
    unplacedFiles: paths.slice(placed.length),
  }
}

const syntheticReview = (prompt: string): AgentReviewAnswer => {
  const { title, files } = decodeMaterial(prompt)

  return {
    markdown: [
      `**Synthetic Agent review of "${title}", written without a model.**`,
      "A fake runner wrote this review without reading the code.",
      ...files
        .slice(0, 2)
        .map(
          ({ path }) =>
            `## Synthetic point on ${basename(path)}\n\nA fake runner raised this about \`${path}\`.`,
        ),
    ].join("\n\n"),
  }
}

export const fakeAgentRunners = Layer.succeed(
  AgentRunners,
  AgentRunners.of({
    select: ({ engine }) =>
      Effect.succeed({
        identity: { engine, model: "fake/synthetic" },
        readsFiles: true,
        run: (task) =>
          Schema.decodeUnknownEffect(task.answer)(
            Object.is(task.answer, AgentReviewAnswer)
              ? syntheticReview(task.prompt)
              : Object.is(task.answer, AskAgentAnswer)
                ? { answer: "A synthetic answer: no agent read this code." }
                : syntheticTour(task.prompt),
          ).pipe(Effect.orDie, Effect.delay("2 seconds")),
      }),
  }),
)
