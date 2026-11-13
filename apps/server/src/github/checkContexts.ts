import { Check, type Checks, type CheckState } from "@glass/contracts"
import { Schema } from "effect"

const MAX_CHECK_CONTEXTS = 100

export const StatusState = Schema.Literals(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"])

const rollupStates: Record<typeof StatusState.Type, Checks> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "running",
  EXPECTED: "running",
}

export const checksOfRollup = (
  rollup: { readonly state: typeof StatusState.Type } | null | undefined,
): Checks => (rollup == null ? "unavailable" : rollupStates[rollup.state])

/** The checks on a PR's head commit, each one a check run or a commit status. */
export const CHECK_CONTEXTS_FIELDS = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${MAX_CHECK_CONTEXTS}) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }`

const CheckRun = Schema.Struct({
  __typename: Schema.Literal("CheckRun"),
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  detailsUrl: Schema.NullOr(Schema.String),
  checkSuite: Schema.Struct({
    workflowRun: Schema.NullOr(Schema.Struct({ workflow: Schema.Struct({ name: Schema.String }) })),
  }),
})

const StatusContext = Schema.Struct({
  __typename: Schema.Literal("StatusContext"),
  context: Schema.String,
  state: StatusState,
  targetUrl: Schema.NullOr(Schema.String),
})

export const CheckContexts = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      commit: Schema.Struct({
        statusCheckRollup: Schema.NullOr(
          Schema.Struct({
            contexts: Schema.Struct({
              nodes: Schema.Array(Schema.Union([CheckRun, StatusContext])),
            }),
          }),
        ),
      }),
    }),
  ),
})

const checkRunState = (run: typeof CheckRun.Type): CheckState => {
  if (run.status !== "COMPLETED") return "running"

  switch (run.conclusion) {
    case "SUCCESS":
    case "NEUTRAL":
      return "passed"
    case "SKIPPED":
    case "STALE":
      return "skipped"
    default:
      return "failed"
  }
}

const statusStates: Record<typeof StatusState.Type, CheckState> = {
  SUCCESS: "passed",
  FAILURE: "failed",
  ERROR: "failed",
  PENDING: "running",
  EXPECTED: "running",
}

const checkOfContext = (context: typeof CheckRun.Type | typeof StatusContext.Type) => {
  if (context.__typename === "StatusContext") {
    return new Check({
      name: context.context,
      state: statusStates[context.state],
      url: context.targetUrl,
    })
  }

  const workflow = context.checkSuite.workflowRun?.workflow.name

  return new Check({
    name: workflow === undefined ? context.name : `${workflow} / ${context.name}`,
    state: checkRunState(context),
    url: context.detailsUrl,
  })
}

export const checksOfCommits = (commits: typeof CheckContexts.Type): ReadonlyArray<Check> =>
  (commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(checkOfContext)
