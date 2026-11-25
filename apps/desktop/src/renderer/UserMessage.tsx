import {
  type AnsweredQuestion,
  type CapturedContext,
  type FeedbackNote,
  type Image,
  type MessageContext,
  shortSha,
} from "@glass/contracts"
import { Match, Predicate } from "effect"
import { useState } from "react"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageContent } from "@/components/ui/message"
import { MessageText } from "./Mentions"
import { createImageViewer, ImageViewer } from "./ImageViewer"
import { Attachment } from "./MessageBox"
import { SentFeedback } from "./FeedbackNotes"
import { referenceText } from "./queue"

function AttachedImages(props: { images: ReadonlyArray<Image> }) {
  const [viewer] = useState(createImageViewer)

  return (
    props.images.length > 0 && (
      <div className="flex flex-wrap justify-end gap-2">
        {props.images.map((_, index) => (
          <Attachment
            key={index}
            images={props.images}
            index={index}
            viewer={viewer}
            className="max-h-40 max-w-60 rounded-lg border object-contain"
          />
        ))}
        <ImageViewer controller={viewer} />
      </div>
    )
  )
}

export const contextLabel = (context: CapturedContext) =>
  Match.value(context).pipe(
    Match.tagsExhaustive({
      PullRequest: ({ pullRequest, revision }) =>
        `${referenceText(pullRequest)} at ${shortSha(revision.head)}`,
      Thread: ({ name }) => name,
    }),
  )

const answersLabel = (answers: ReadonlyArray<AnsweredQuestion>) =>
  answers.length === 1 ? "Your answer" : `Your ${answers.length} answers`

export const sentFrom = (context: MessageContext | null) =>
  context === null
    ? undefined
    : Match.valueTags(context, {
        PullRequest: (viewed) => `From ${contextLabel(viewed)}`,
        Thread: (viewed) => `From ${contextLabel(viewed)}`,
        QuestionsAnswered: ({ answers }) => answersLabel(answers),
      })

export function UserMessage(props: {
  message: string
  images: ReadonlyArray<Image>
  feedback?: ReadonlyArray<FeedbackNote>
  label?: string | undefined
}) {
  const feedback = props.feedback ?? []

  return (
    <Message align="end">
      <MessageContent>
        {props.label !== undefined && (
          <span className="self-end text-xs text-muted-foreground">{props.label}</span>
        )}
        <AttachedImages images={props.images} />
        {props.message !== "" && (
          <Bubble align="end" variant="muted">
            <BubbleContent className="whitespace-pre-wrap">
              <MessageText text={props.message} />
            </BubbleContent>
          </Bubble>
        )}
        {feedback.length > 0 && (
          <SentFeedback feedback={feedback} className="w-full max-w-xl self-end" />
        )}
      </MessageContent>
    </Message>
  )
}

function AnsweredQuestions(props: { answers: ReadonlyArray<AnsweredQuestion>; label: string }) {
  return (
    <Message align="end">
      <MessageContent>
        <span className="self-end text-xs text-muted-foreground">{props.label}</span>
        <dl className="flex flex-col gap-2 text-sm">
          {props.answers.map(({ questionId, question, answer }) => (
            <div key={questionId} className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">{question}</dt>
              <dd className="whitespace-pre-wrap text-pretty break-words">{answer}</dd>
            </div>
          ))}
        </dl>
      </MessageContent>
    </Message>
  )
}

export function SentMessage(props: {
  message: string
  images: ReadonlyArray<Image>
  context: MessageContext | null
  feedback?: ReadonlyArray<FeedbackNote>
  steered?: boolean
}) {
  const { context } = props

  const steered = (label: string) => (props.steered === true ? `Steered · ${label}` : label)

  if (Predicate.isTagged(context, "QuestionsAnswered"))
    return <AnsweredQuestions answers={context.answers} label={steered("Answered in the Inbox")} />

  const from = sentFrom(context)

  return (
    <UserMessage
      message={props.message}
      images={props.images}
      feedback={props.feedback ?? []}
      label={from === undefined ? (props.steered === true ? "Steered" : undefined) : steered(from)}
    />
  )
}
