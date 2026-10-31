import type { ReviewDestination, ReviewPosition } from "@glass/contracts"
import { AsyncResult } from "effect/reactivity"
import { GitPullRequest } from "lucide-react"
import { useConnection } from "./connection"
import { ContinueCard, ContinueInvitation } from "./ContinueCard"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"
import { defaultListSearch } from "./reviewsArea"

const positionLabel = (position: ReviewPosition) => {
  if (position.tab === "overview") return "Overview"

  if (position.tab === "files") return "Files"

  return position.order === "tour" ? "Changes · Tour order" : "Changes · Path order"
}

function ReviewInvitation(props: { title: string }) {
  return (
    <ContinueInvitation
      link={{ to: "/reviews", search: defaultListSearch }}
      icon={GitPullRequest}
      title={props.title}
      hint="Open a pull request and Glass will remember your place."
      action="Browse pull requests"
    />
  )
}

export function ReviewContinueCard(props: { destination: ReviewDestination | undefined }) {
  return props.destination === undefined ? (
    <ReviewInvitation title="No pull request yet" />
  ) : (
    <LastPullRequest destination={props.destination} />
  )
}

function LastPullRequest(props: { destination: ReviewDestination }) {
  const { destination } = props
  const { result, retry } = useConnection()
  const { owner, repo, number } = destination.pullRequest
  const file = destination.position.tab === "overview" ? null : destination.position.file

  return AsyncResult.builder(result)
    .onSuccess((connection) =>
      destination.login.toLowerCase() !== connection.login.toLowerCase() ? (
        <ReviewInvitation title="No saved review for this account" />
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
