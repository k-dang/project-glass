import type { ReviewDestination, ReviewPosition } from "@glass/contracts"
import { AsyncResult } from "effect/reactivity"
import { GitPullRequest } from "lucide-react"
import { useConnection } from "./connection"
import { ContinueCard, rememberPlaceHint } from "./ContinueCard"
import { Empty } from "./Lists"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"

const positionLabel = (position: ReviewPosition) => {
  if (position.tab === "overview") return "Overview"

  if (position.tab === "files") return "Files"

  return position.order === "tour" ? "Changes · Tour order" : "Changes · Path order"
}

export function ReviewContinueCard(props: { destination: ReviewDestination }) {
  const { destination } = props
  const { result, retry } = useConnection()
  const { owner, repo, number } = destination.pullRequest
  const file = destination.position.tab === "overview" ? null : destination.position.file

  return AsyncResult.builder(result)
    .onSuccess((connection) =>
      destination.login.toLowerCase() !== connection.login.toLowerCase() ? (
        <Empty title="No saved review for this account">{rememberPlaceHint}</Empty>
      ) : (
        <ContinueCard
          link={{ to: "/reviews/$owner/$repo/$number", params: destination.pullRequest }}
          name={`${owner}/${repo}#${number}`}
          icon={GitPullRequest}
          heading={
            <>
              {owner}/{repo}
              <span className="text-muted-foreground">#{number}</span>
            </>
          }
          subtitle={`Reviews · ${positionLabel(destination.position)}`}
        >
          {file !== null && (
            <p className="mt-2 truncate font-mono text-xs text-muted-foreground" title={file}>
              {file}
            </p>
          )}
        </ContinueCard>
      ),
    )
    .onFailure((cause) => (
      <ProblemAlert problem={problemOf(cause)} action={{ label: "Try again", run: retry }} />
    ))
    .orElse(() => (
      <output className="py-6 text-sm text-muted-foreground">Checking your GitHub account…</output>
    ))
}
