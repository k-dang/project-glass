import { type CapturedContext, type FeedbackNote, type Image, shortSha } from "@glass/contracts"
import { Match } from "effect"
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

export const sentFrom = (context: CapturedContext | null) =>
  context === null ? undefined : `From ${contextLabel(context)}`

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
