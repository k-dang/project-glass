import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type ThreadDestination, repositoryKey } from "@glass/contracts"
import { AsyncResult } from "effect/reactivity"
import { Sparkles } from "lucide-react"
import { threadsAtom, placeNames } from "./threadsArea"
import { harnessNames } from "./harnesses"
import { ContinueCard, ContinueCardLoading, ContinueInvitation } from "./ContinueCard"
import { ProblemAlert } from "./ProblemAlert"
import { streamProblem } from "./problems"

function ThreadInvitation(props: { title: string }) {
  return (
    <ContinueInvitation
      link={{ to: "/threads/new" }}
      icon={Sparkles}
      title={props.title}
      hint="Start a Thread and Glass will remember your place."
      action="Start a Thread"
    />
  )
}

export function ThreadContinueCard(props: { destination: ThreadDestination | undefined }) {
  return props.destination === undefined ? (
    <ThreadInvitation title="No Thread yet" />
  ) : (
    <LastThread destination={props.destination} />
  )
}

function LastThread(props: { destination: ThreadDestination }) {
  const result = useAtomValue(threadsAtom)
  const retry = useAtomRefresh(threadsAtom)

  return AsyncResult.builder(result)
    .onSuccess((threads) => {
      const thread = threads.find(({ id }) => id === props.destination.threadId)

      return thread === undefined ? (
        <ThreadInvitation title="Your last Thread is gone" />
      ) : (
        <ContinueCard
          link={{
            to: "/threads/$threadId",
            params: { threadId: thread.id },
          }}
          name={thread.name}
          icon={Sparkles}
          subtitle={`Threads · ${repositoryKey(thread.repository)} · ${harnessNames[thread.harness]} · ${placeNames[thread.place._tag]}`}
        />
      )
    })
    .onFailure((cause) => (
      <ProblemAlert problem={streamProblem(cause)} action={{ label: "Try again", run: retry }} />
    ))
    .orElse(() => <ContinueCardLoading label="Loading your Threads…" />)
}
