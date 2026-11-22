import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { AgentRunners } from "./agentRunners"
import { Deadlines } from "./ServerConfig"

const MODEL = "claude-haiku-5-5"

const REQUEST_LIMIT = 4000

const instructions = `You name git branches for a coding agent's work.
Answer with one short branch name for the request: a type prefix (feat, fix, refactor, perf, test, docs or chore), a slash, then two to five lowercase words joined by hyphens, like fix/login-error or feat/add-search.`

export const BranchAnswer = Schema.Struct({ branch: Schema.String })

export const placeholderBranch = () => `agent/${randomUUID().slice(0, 8)}`

export const firstFreeBranch = (branch: string, taken: ReadonlyArray<string>) =>
  Option.fromUndefinedOr(
    [branch, ...Array.from({ length: 8 }, (_, index) => `${branch}-${index + 2}`)].find(
      (candidate) => !taken.includes(candidate),
    ),
  )

const branchNameOf = (raw: string): Option.Option<string> => {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .split("/")
    .map((part) => part.replace(/-+/g, "-").replace(/^-|-$/g, ""))
    .filter((part) => part !== "")
    .join("/")
    .slice(0, 60)
    .replace(/[/-]+$/, "")

  return name === "" ? Option.none() : Option.some(name)
}

export class BranchNames extends Context.Service<
  BranchNames,
  {
    readonly suggest: (request: string) => Effect.Effect<Option.Option<string>>
  }
>()("@glass/server/BranchNames") {
  static readonly layer = Layer.effect(
    BranchNames,
    Effect.gen(function* () {
      const runners = yield* AgentRunners
      const fs = yield* FileSystem.FileSystem
      const deadlines = yield* Deadlines

      const suggest = Effect.fn("BranchNames.suggest")(
        function* (request: string) {
          const runner = yield* runners.select({
            harness: "claude-code",
            models: { "claude-code": MODEL, pi: { provider: "anthropic", modelId: MODEL } },
          })

          const { branch } = yield* runner.run({
            subject: "branch name",
            instructions,
            prompt: `Request:\n${request.slice(0, REQUEST_LIMIT)}`,
            answer: BranchAnswer,
            tools: "none",
            checkout: yield* fs.makeTempDirectoryScoped({ prefix: "glass-branch-name-" }),
          })

          return branchNameOf(branch)
        },
        (named) =>
          named.pipe(
            Effect.scoped,
            Effect.timeout(deadlines.branchNameMs),
            Effect.catchCause((cause) =>
              Effect.logWarning("Couldn't name a Thread's branch", cause).pipe(
                Effect.as(Option.none()),
              ),
            ),
          ),
      )

      return BranchNames.of({ suggest })
    }),
  )
}
