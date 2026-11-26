import { Effect, Layer, Schema } from "effect"
import { basename } from "node:path"
import { AgentRunners } from "../src/agentRunners"
import { AskAgentAnswer } from "../src/askPrompt"
import { BranchAnswer } from "../src/BranchNames"
import type { TourAnswer } from "../src/tourPrompt"
import { RATE_LIMIT_TITLE } from "./demoPullRequests"
import { demoTour } from "./demoTour"
import { tourOverviewExamples } from "./demoTourOverviews"

const chapterSize = 2

const material = Schema.fromJsonString(
  Schema.Struct({
    title: Schema.String,
    files: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
  }),
)

export const decodeMaterial = (prompt: string) =>
  Schema.decodeUnknownSync(material)(prompt.slice(prompt.indexOf("{")).split("\n")[0])

const syntheticTour = (prompt: string): TourAnswer => {
  const { title, files = [] } = decodeMaterial(prompt)

  if (title === RATE_LIMIT_TITLE) return demoTour

  const example = tourOverviewExamples.find((entry) => entry.title === title)

  if (example !== undefined) return example.tour

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

const syntheticBranch = (prompt: string, branchFor: (request: string) => string | undefined) => {
  const request = prompt.split("\n").slice(1).join("\n")

  return { branch: branchFor(request) ?? `feat/${request.split(/\s+/).slice(0, 4).join("-")}` }
}

export const fakeAgentRunners = (branchFor: (request: string) => string | undefined) =>
  Layer.succeed(
    AgentRunners,
    AgentRunners.of({
      select: ({ harness }) =>
        Effect.succeed({
          identity: { harness, model: "fake/synthetic" },
          run: (task) =>
            Schema.decodeUnknownEffect(task.answer)(
              Object.is(task.answer, BranchAnswer)
                ? syntheticBranch(task.prompt, branchFor)
                : Object.is(task.answer, AskAgentAnswer)
                  ? { answer: "A synthetic answer: no agent read this code." }
                  : syntheticTour(task.prompt),
            ).pipe(Effect.orDie, Effect.delay("2 seconds")),
        }),
    }),
  )
