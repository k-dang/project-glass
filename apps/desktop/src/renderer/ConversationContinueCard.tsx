import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type ConversationDestination, repositoryKey } from "@glass/contracts"
import { AsyncResult } from "effect/reactivity"
import { Sparkles } from "lucide-react"
import { conversationsAtom, placeNames } from "./conversationsArea"
import { harnessNames } from "./harnesses"
import { ContinueCard, ContinueCardLoading, ContinueInvitation } from "./ContinueCard"
import { ProblemAlert } from "./ProblemAlert"
import { streamProblem } from "./problems"

function ConversationInvitation(props: { title: string }) {
  return (
    <ContinueInvitation
      link={{ to: "/conversations/new" }}
      icon={Sparkles}
      title={props.title}
      hint="Start a Conversation and Glass will remember your place."
      action="Start a Conversation"
    />
  )
}

export function ConversationContinueCard(props: {
  destination: ConversationDestination | undefined
}) {
  return props.destination === undefined ? (
    <ConversationInvitation title="No Conversation yet" />
  ) : (
    <LastConversation destination={props.destination} />
  )
}

function LastConversation(props: { destination: ConversationDestination }) {
  const result = useAtomValue(conversationsAtom)
  const retry = useAtomRefresh(conversationsAtom)

  return AsyncResult.builder(result)
    .onSuccess((conversations) => {
      const conversation = conversations.find(({ id }) => id === props.destination.conversationId)

      return conversation === undefined ? (
        <ConversationInvitation title="Your last Conversation is gone" />
      ) : (
        <ContinueCard
          link={{
            to: "/conversations/$conversationId",
            params: { conversationId: conversation.id },
          }}
          name={conversation.name}
          icon={Sparkles}
          subtitle={`Conversations · ${repositoryKey(conversation.repository)} · ${harnessNames[conversation.engine]} · ${placeNames[conversation.place._tag]}`}
        />
      )
    })
    .onFailure((cause) => (
      <ProblemAlert problem={streamProblem(cause)} action={{ label: "Try again", run: retry }} />
    ))
    .orElse(() => <ContinueCardLoading label="Loading your Conversations…" />)
}
