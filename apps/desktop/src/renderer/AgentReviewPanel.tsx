import type { FollowUp, SuggestedDraft } from "@glass/contracts"
import { cn } from "cn"
import { ArrowUp, Check, LoaderCircle, MessageSquarePlus, Square } from "lucide-react"
import { type KeyboardEvent, useState } from "react"
import { Streamdown } from "streamdown"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { Textarea } from "@/components/ui/textarea"
import { UserMessage } from "./AgentView"
import type { ShowNote } from "./changesView"
import { LineLocation, pathLineName } from "./Discussions"
import { Elapsed } from "./Elapsed"
import { ProblemAlert } from "./ProblemAlert"
import type { AgentReviewControls } from "./useAgentReview"
import { type DraftStore, useDraftsLocked, useLineDraftPlaces } from "./useDrafts"

export function AgentReviewMarkdown(props: { markdown: string; className?: string }) {
  return (
    <Streamdown
      className={cn(
        "text-sm leading-relaxed break-words [&_h2]:mt-5 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold",
        props.className,
      )}
    >
      {props.markdown}
    </Streamdown>
  )
}

const fileName = (path: string) => path.split("/").at(-1) ?? path

/** A Draft the agent proposed: the user edits it, then adds it to their pending Review. */
function SuggestedDraftCard(props: {
  draft: SuggestedDraft
  drafts: DraftStore
  addable: boolean
  show: ShowNote
}) {
  const { draft } = props
  const [body, setBody] = useState(draft.body)
  const locked = useDraftsLocked(props.drafts)

  const onLine = useLineDraftPlaces(props.drafts).some(
    (place) => place.path === draft.path && place.side === draft.side && place.line === draft.line,
  )

  const name = pathLineName(draft.path, draft.side, draft.line)

  return (
    <section
      aria-label={`Suggested draft on ${name}`}
      className="flex flex-col gap-2 rounded-lg border bg-background p-2"
    >
      <button
        type="button"
        title={draft.path}
        className="flex min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={() => props.show.line(draft.path, draft.side, draft.line)}
      >
        <MessageSquarePlus aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{fileName(draft.path)}</span>
        <LineLocation side={draft.side} line={draft.line} />
      </button>
      {onLine ? (
        <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check aria-hidden className="size-3.5 shrink-0 text-added" />
          You have a Draft on this line.
        </p>
      ) : props.addable ? (
        <>
          <Textarea
            aria-label={`Suggested draft on ${name}`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="text-sm"
          />
          <div className="flex justify-end">
            <Button
              size="xs"
              disabled={locked || body.trim() === ""}
              onClick={() => props.drafts.add(draft.path, draft.side, draft.line, body.trim())}
            >
              Add Draft
            </Button>
          </div>
        </>
      ) : (
        <AgentReviewMarkdown markdown={draft.body} />
      )}
    </section>
  )
}

function FollowUpView(props: {
  followUp: FollowUp
  drafts: DraftStore
  addable: boolean
  show: ShowNote
}) {
  return (
    <li className="flex flex-col gap-2">
      <UserMessage message={props.followUp.message} images={[]} />
      <AgentReviewMarkdown markdown={props.followUp.answer} />
      {props.followUp.suggestedDrafts.map((draft) => (
        <SuggestedDraftCard
          key={`${draft.path}:${draft.side}:${draft.line}`}
          draft={draft}
          drafts={props.drafts}
          addable={props.addable}
          show={props.show}
        />
      ))}
    </li>
  )
}

function Composer(props: {
  disabled: boolean
  running: boolean
  onSend: (message: string) => void
  onStop: () => void
}) {
  const [message, setMessage] = useState("")

  const send = () => {
    const trimmed = message.trim()

    if (props.disabled || props.running || trimmed === "") return

    props.onSend(trimmed)
    setMessage("")
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter can confirm an input method's candidates.
    if (event.nativeEvent.isComposing) return

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <form
      className="shrink-0 border-t px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      <InputGroup>
        <InputGroupTextarea
          aria-label="Follow up"
          className="max-h-40 p-3"
          placeholder="Ask about the review, or have it draft comments"
          value={message}
          disabled={props.disabled}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <InputGroupAddon align="block-end" className="justify-end gap-1">
          {props.running ? (
            <InputGroupButton
              size="icon-sm"
              variant="secondary"
              className="rounded-full"
              aria-label="Stop"
              onClick={props.onStop}
            >
              <Square className="fill-current" />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              className="rounded-full"
              disabled={props.disabled || message.trim() === ""}
              aria-label="Send"
            >
              <ArrowUp />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}

/**
 * The whole Agent review in the file panel, so it reads beside the diff, with its Follow-ups:
 * the user's messages about it and the agent's answers, which can suggest Drafts.
 */
export function AgentReviewPanel(props: {
  controls: AgentReviewControls
  drafts: DraftStore
  show: ShowNote
}) {
  const { review, job, outdated } = props.controls

  if (review === null) return null

  const reviewing = job?.status === "reviewing"
  const running = job?.status === "following-up"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section aria-label="Agent review" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <AgentReviewMarkdown markdown={review.markdown} />
        <ol aria-label="Follow-ups" className="m-0 mt-4 flex list-none flex-col gap-4 p-0">
          {review.followUps.map((followUp, index) => (
            <FollowUpView
              key={index}
              followUp={followUp}
              drafts={props.drafts}
              addable={!outdated}
              show={props.show}
            />
          ))}
          {job?.status === "following-up" && (
            <li className="flex flex-col gap-2">
              <UserMessage message={job.message} images={[]} />
              <output className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle
                  aria-hidden
                  className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                />
                <span className="flex-1">The agent is reading the PR's code…</span>
                <Elapsed startedAt={job.startedAt} />
              </output>
            </li>
          )}
          {job?.status === "follow-up-failed" && (
            <li className="flex flex-col gap-2">
              <UserMessage message={job.message} images={[]} />
              <ProblemAlert
                problem={{ title: "Follow-up failed", detail: job.reason.message }}
                action={{ label: "Retry", run: () => props.controls.followUp(job.message) }}
              />
            </li>
          )}
        </ol>
      </section>
      {props.controls.followUpProblem !== null && (
        <div className="px-4 pt-2">
          <ProblemAlert problem={props.controls.followUpProblem} />
        </div>
      )}
      {outdated ? (
        <p className="m-0 shrink-0 border-t px-4 py-3 text-sm text-muted-foreground">
          Written for an older Revision. Review again to follow up.
        </p>
      ) : (
        <Composer
          disabled={reviewing}
          running={running}
          onSend={props.controls.followUp}
          onStop={props.controls.cancel}
        />
      )}
    </div>
  )
}
