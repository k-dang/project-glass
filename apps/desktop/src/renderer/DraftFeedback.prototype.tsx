// PROTOTYPE — throwaway, not for main. Three ways to follow up on an Agent review by drafting
// PR feedback from its points, inside the Agent review tab beside the diff. Switch with
// `?feedbackVariant=A|B|C` on the PR workspace route (or ← / →). Everything is stubbed: no
// runner calls, and "Add Draft" only appends to the in-memory list the switcher shows.
//   A  Per-point actions: each review point gets its own "Draft comment".
//   B  Draft tray: one "Draft feedback" pass turns the review into Suggested drafts to pick from.
//   C  Follow-up chat: a conversation under the review that proposes Drafts inline.
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { cn } from "cn"
import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  MessageSquarePlus,
  PencilLine,
  ScanSearch,
  Sparkles,
  X,
} from "lucide-react"
import { useEffect, useState } from "react"
import { Streamdown } from "streamdown"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"

// ---------------------------------------------------------------------------------------------
// Variant plumbing

export const feedbackVariants = ["A", "B", "C"] as const
export type FeedbackVariant = (typeof feedbackVariants)[number]

const variantNames: Record<FeedbackVariant, string> = {
  A: "Per-point actions",
  B: "Draft tray",
  C: "Follow-up chat",
}

export function useFeedbackVariant(): FeedbackVariant {
  const search = useRouterState({ select: (state) => state.location.search }) as Record<
    string,
    unknown
  >

  return feedbackVariants.find((variant) => variant === search["feedbackVariant"]) ?? "A"
}

/** What "Add Draft" would send to CreateDraft. `line: null` means it goes in the Review summary. */
export type StubDraft = { path: string; line: number | null; body: string }

export function FeedbackVariantSwitcher(props: { drafts: ReadonlyArray<StubDraft> }) {
  const current = useFeedbackVariant()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const index = feedbackVariants.indexOf(current)

  const go = (step: number) => {
    const next =
      feedbackVariants[(index + step + feedbackVariants.length) % feedbackVariants.length]
    void navigate({
      to: ".",
      search: ((previous: Record<string, unknown>) => ({
        ...previous,
        feedbackVariant: next,
      })) as never,
      replace: true,
    })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, [contenteditable]")) return
      if (event.key === "ArrowLeft") go(-1)
      if (event.key === "ArrowRight") go(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {open && (
        <pre className="max-h-64 w-[28rem] overflow-auto rounded-lg bg-neutral-900 p-3 text-xs text-neutral-100 shadow-lg">
          {props.drafts.length === 0
            ? "No stub Drafts yet."
            : JSON.stringify(props.drafts, null, 2)}
        </pre>
      )}
      <div className="flex items-center gap-1 rounded-full bg-fuchsia-600 px-2 py-1 text-sm font-medium text-white shadow-lg ring-2 ring-white/40">
        <button type="button" aria-label="Previous variant" onClick={() => go(-1)}>
          <ChevronLeft aria-hidden className="size-4" />
        </button>
        <span className="px-2">
          {current} ({variantNames[current]})
        </span>
        <button type="button" aria-label="Next variant" onClick={() => go(1)}>
          <ChevronRight aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          className="ml-1 rounded-full bg-white/20 px-2 text-xs tabular-nums"
          onClick={() => setOpen(!open)}
        >
          {props.drafts.length} stub Drafts
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Fixtures: the fake backend writes a two-line review, so the prototype reads a realistic one.

const lead = `**Failure cleanup misses scheduled card locks once they move to \`pending\`.** This change adds a card-lock adapter, provider routing, retry-aware error handling, and a \`Completed\` event for successful locks. The main gap is that failure handling recognizes scheduled work only by its current status, although the workflow moves it to \`pending\` before fulfillment.`

type Severity = "Blocking" | "Should fix" | "Nit"

type Point = {
  title: string
  severity: Severity
  body: string
  /** What a drafting pass would propose for this point. */
  suggestion: StubDraft
}

const points: ReadonlyArray<Point> = [
  {
    title: "Deactivate failed locks after the pending transition",
    severity: "Blocking",
    body: `In \`components/credit_card_component/app/domain/services/spend_control_fulfiller.rb:95\`, \`was_scheduled\` is determined solely by \`scheduled?\`, and only that flag triggers \`Deactivated\` at lines \`113–123\`.

For a \`card_lock\` in \`pending\` with \`scheduled_at\` populated, a closed-card or provider failure emits only \`Failed\`. The control stays active and the next run picks it up again.

Check \`scheduled_at.present?\` instead, or carry the original status through the transition.`,
    suggestion: {
      path: "components/credit_card_component/app/domain/services/spend_control_fulfiller.rb",
      line: 95,
      body: "By the time we get here a scheduled lock has already moved to `pending`, so `scheduled?` is false and the failure path below never emits `Deactivated`. The control stays active and gets picked up again next run. Could this check `scheduled_at.present?` instead (or carry the original status through)?",
    },
  },
  {
    title: "Retry classification swallows provider timeouts",
    severity: "Should fix",
    body: `\`CardLockAdapter#lock!\` rescues \`Faraday::TimeoutError\` into \`ProviderUnavailable\`, which \`RetryPolicy\` treats as permanent. A slow provider response becomes a terminal failure on the first attempt.

Split timeouts into \`ProviderTimeout\` and list it under \`retryable_errors\` in \`config/spend_controls.yml\`.`,
    suggestion: {
      path: "components/credit_card_component/app/adapters/card_lock_adapter.rb",
      line: 41,
      body: "Timeouts land in `ProviderUnavailable` here, which `RetryPolicy` treats as permanent, so one slow response fails the lock for good. Worth splitting out a `ProviderTimeout` that's retryable?",
    },
  },
  {
    title: "Specs miss the pending state",
    severity: "Nit",
    body: `\`spec/domain/services/spend_control_fulfiller_spec.rb\` builds every failing control with \`status: :scheduled\`. Add one example that transitions to \`pending\` first, so the gap above stays covered.`,
    suggestion: {
      path: "spec/domain/services/spend_control_fulfiller_spec.rb",
      line: null,
      body: "nit: every failing control in this spec starts as `:scheduled`; one example that goes through `pending` first would cover the blocking case above.",
    },
  },
]

const fullMarkdown = [lead, ...points.map((p) => `## ${p.title}\n\n**${p.severity}:** ${p.body}`)].join(
  "\n\n",
)

// ---------------------------------------------------------------------------------------------
// Shared bits

const proseClass = cn(
  "text-sm leading-relaxed break-words [&_h2]:mt-5 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold",
  "[&_:not(pre)>code]:text-[0.8125rem] [&_:not(pre)>code]:[overflow-wrap:anywhere]",
)

function Prose(props: { markdown: string; className?: string }) {
  return <Streamdown className={cn(proseClass, props.className)}>{props.markdown}</Streamdown>
}

const severityTone: Record<Severity, string> = {
  Blocking: "bg-destructive/10 text-destructive",
  "Should fix": "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  Nit: "bg-muted text-muted-foreground",
}

function SeverityBadge(props: { severity: Severity }) {
  return <Badge className={severityTone[props.severity]}>{props.severity}</Badge>
}

const fileName = (path: string) => path.split("/").at(-1) ?? path

function Place(props: { draft: StubDraft }) {
  return (
    <code
      title={props.draft.path}
      className="truncate rounded bg-muted px-1 text-xs text-muted-foreground"
    >
      {props.draft.line === null
        ? "Review summary"
        : `${fileName(props.draft.path)}:${props.draft.line}`}
    </code>
  )
}

/** An editable proposed comment: where it lands, its body, and accept / dismiss. */
function DraftEditor(props: {
  draft: StubDraft
  onAdd: (draft: StubDraft) => void
  onDismiss: () => void
  addLabel?: string
}) {
  const [body, setBody] = useState(props.draft.body)

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background p-2">
      <div className="flex items-center gap-2 text-xs">
        <MessageSquarePlus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <Place draft={props.draft} />
      </div>
      <Textarea value={body} onChange={(event) => setBody(event.target.value)} />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={props.onDismiss}>
          Dismiss
        </Button>
        <Button size="xs" onClick={() => props.onAdd({ ...props.draft, body })}>
          {props.addLabel ?? "Add Draft"}
        </Button>
      </div>
    </div>
  )
}

function Added(props: { draft: StubDraft }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed px-2 py-1.5 text-xs text-muted-foreground">
      <Check aria-hidden className="size-3.5 shrink-0 text-emerald-600" />
      <span>Added as a Draft on</span>
      <Place draft={props.draft} />
    </div>
  )
}

type Props = { onAddDraft: (draft: StubDraft) => void }

// ---------------------------------------------------------------------------------------------
// A — Per-point actions. The review splits at its `##` points; each point carries its severity
// and a "Draft comment" that opens a proposed comment right under it.

export function PerPointActions(props: Props) {
  const [state, setState] = useState<Record<number, "editing" | StubDraft>>({})
  const blockers = points.flatMap((point, index) =>
    point.severity === "Blocking" && state[index] === undefined ? [index] : [],
  )

  return (
    <section aria-label="Agent review" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <Prose markdown={lead} />
      {blockers.length > 0 && (
        <Button
          variant="outline"
          size="xs"
          className="mt-3"
          onClick={() =>
            setState((previous) => ({
              ...previous,
              ...Object.fromEntries(blockers.map((index) => [index, "editing" as const])),
            }))
          }
        >
          <Sparkles aria-hidden />
          Draft comments for {blockers.length} blocker{blockers.length === 1 ? "" : "s"}
        </Button>
      )}
      {points.map((point, index) => {
        const current = state[index]

        return (
          <article key={point.title} className="mt-5 border-t pt-4">
            <header className="mb-1.5 flex items-start gap-2">
              <h2 className="min-w-0 flex-1 text-sm font-semibold">{point.title}</h2>
              <SeverityBadge severity={point.severity} />
            </header>
            <Prose markdown={point.body} />
            <div className="mt-2">
              {current === undefined ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="-ml-2 text-muted-foreground"
                  onClick={() => setState({ ...state, [index]: "editing" })}
                >
                  <PencilLine aria-hidden />
                  Draft comment
                </Button>
              ) : current === "editing" ? (
                <DraftEditor
                  draft={point.suggestion}
                  onAdd={(draft) => {
                    props.onAddDraft(draft)
                    setState({ ...state, [index]: draft })
                  }}
                  onDismiss={() => {
                    const { [index]: _, ...rest } = state
                    setState(rest)
                  }}
                />
              ) : (
                <Added draft={current} />
              )}
            </div>
          </article>
        )
      })}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// B — Draft tray. The review reads as today; a footer asks for one drafting pass with a note and
// which severities to include. The tab then shows Suggested drafts to tick, edit, and add at once.
// Points Glass can't place on a diff line fall into the Review summary.

export function DraftTray(props: Props) {
  const [mode, setMode] = useState<"review" | "suggested" | "added">("review")
  const [include, setInclude] = useState<ReadonlySet<Severity>>(new Set(["Blocking"]))
  const [note, setNote] = useState("")
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set())
  const [bodies, setBodies] = useState<Record<number, string>>({})

  const suggested = points.flatMap((point, index) =>
    include.has(point.severity) ? [{ index, point }] : [],
  )
  const placed = suggested.filter(({ point }) => point.suggestion.line !== null)
  const summary = suggested.filter(({ point }) => point.suggestion.line === null)

  const toggle = <T,>(set: ReadonlySet<T>, value: T) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  if (mode === "review")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <section aria-label="Agent review" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <Prose markdown={fullMarkdown} />
        </section>
        <footer className="flex shrink-0 flex-col gap-2 border-t bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Draft feedback for</span>
            {(["Blocking", "Should fix", "Nit"] as const).map((severity) => (
              <button
                key={severity}
                type="button"
                onClick={() => setInclude(toggle(include, severity))}
                className={cn(
                  "rounded-full border px-2 py-0.5",
                  include.has(severity)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "text-muted-foreground",
                )}
              >
                {severity}
              </button>
            ))}
          </div>
          <Textarea
            placeholder="How should it sound? e.g. terse, ask questions rather than prescribe"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="min-h-10"
          />
          <Button
            size="sm"
            disabled={include.size === 0}
            onClick={() => {
              setPicked(new Set(suggested.map(({ index }) => index)))
              setMode("suggested")
            }}
          >
            <Sparkles aria-hidden />
            Draft feedback
          </Button>
        </footer>
      </div>
    )

  if (mode === "added")
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm">
        <Check aria-hidden className="size-6 text-emerald-600" />
        <p>
          Added {placed.filter(({ index }) => picked.has(index)).length} Drafts
          {summary.some(({ index }) => picked.has(index)) && " and a Review summary"}. They're on
          the diff now, ready to submit with your Review.
        </p>
        <Button variant="outline" size="sm" onClick={() => setMode("review")}>
          Back to the Agent review
        </Button>
      </div>
    )

  const card = ({ index, point }: { index: number; point: Point }) => (
    <li key={index} className="flex gap-2 rounded-lg border p-2">
      <Checkbox
        checked={picked.has(index)}
        onCheckedChange={() => setPicked(toggle(picked, index))}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Place draft={point.suggestion} />
          <span className="flex-1" />
          <SeverityBadge severity={point.severity} />
        </div>
        <p className="text-xs text-muted-foreground">From: {point.title}</p>
        <Textarea
          value={bodies[index] ?? point.suggestion.body}
          onChange={(event) => setBodies({ ...bodies, [index]: event.target.value })}
          disabled={!picked.has(index)}
        />
      </div>
    </li>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm">
        <Sparkles aria-hidden className="size-4 text-muted-foreground" />
        <span className="flex-1 font-medium">Suggested drafts</span>
        <Button variant="ghost" size="xs" onClick={() => setMode("review")}>
          <X aria-hidden />
          Back
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {note !== "" && (
          <p className="mb-3 text-xs text-muted-foreground">Written to your note: “{note}”</p>
        )}
        <ul className="flex flex-col gap-2">{placed.map(card)}</ul>
        {summary.length > 0 && (
          <>
            <h3 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">
              Not on a diff line, so these go in the Review summary
            </h3>
            <ul className="flex flex-col gap-2">{summary.map(card)}</ul>
          </>
        )}
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t px-4 py-2">
        <Button
          size="sm"
          disabled={picked.size === 0}
          onClick={() => {
            for (const { index, point } of suggested)
              if (picked.has(index))
                props.onAddDraft({ ...point.suggestion, body: bodies[index] ?? point.suggestion.body })
            setMode("added")
          }}
        >
          Add {picked.size} to my Review
        </Button>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// C — Follow-up chat. The review collapses to its opening; under it the user talks to the agent
// about the review, and the agent answers in prose and proposes Drafts as cards in the thread.

type ChatMessage =
  | { from: "user"; text: string }
  | { from: "agent"; text: string; proposals: ReadonlyArray<number> }

const cannedReplies: ReadonlyArray<{ match: RegExp; text: string; proposals: Array<number> }> = [
  {
    match: /blocker|draft|comment/i,
    text: "Here's a comment for the one blocking point, worded as a question since the author may know about the `pending` transition already. I left the timeout point out; say if you want it too.",
    proposals: [0],
  },
  {
    match: /timeout|retry|real/i,
    text: "Yes. `RetryPolicy#retryable?` in `app/domain/policies/retry_policy.rb:18` only retries classes listed in `retryable_errors`, and `ProviderUnavailable` isn't there. I'd keep it as should-fix, not blocking: it fails closed, so nothing is wrongly locked.",
    proposals: [1],
  },
]

const fallbackReply = {
  text: "I looked again at the change with that in mind. Nothing new beyond the review's points; want me to draft comments for any of them?",
  proposals: [] as Array<number>,
}

export function FollowUpChat(props: Props) {
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState<ReadonlyArray<ChatMessage>>([])
  const [input, setInput] = useState("")
  const [resolved, setResolved] = useState<Record<string, "dismissed" | StubDraft>>({})

  const send = (text: string) => {
    if (text.trim() === "") return
    const reply = cannedReplies.find(({ match }) => match.test(text)) ?? fallbackReply
    setMessages([
      ...messages,
      { from: "user", text },
      { from: "agent", text: reply.text, proposals: reply.proposals },
    ])
    setInput("")
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="rounded-lg bg-muted/40 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ScanSearch aria-hidden className="size-3.5" />
            Agent review
          </div>
          <Prose markdown={expanded ? fullMarkdown : lead} />
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : `Show all ${points.length} points`}
          </Button>
        </div>

        <ol className="mt-4 flex flex-col gap-3">
          {messages.map((message, messageIndex) =>
            message.from === "user" ? (
              <li
                key={messageIndex}
                className="ml-8 self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
              >
                {message.text}
              </li>
            ) : (
              <li key={messageIndex} className="flex flex-col gap-2">
                <Prose markdown={message.text} />
                {message.proposals.map((pointIndex) => {
                  const key = `${messageIndex}-${pointIndex}`
                  const outcome = resolved[key]
                  const suggestion = points[pointIndex]!.suggestion

                  if (outcome === "dismissed") return null
                  if (outcome !== undefined) return <Added key={key} draft={outcome} />

                  return (
                    <DraftEditor
                      key={key}
                      draft={suggestion}
                      onAdd={(draft) => {
                        props.onAddDraft(draft)
                        setResolved({ ...resolved, [key]: draft })
                      }}
                      onDismiss={() => setResolved({ ...resolved, [key]: "dismissed" })}
                    />
                  )
                })}
              </li>
            ),
          )}
        </ol>
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t px-4 py-3">
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {["Draft comments for the blockers", "Is the timeout point real?"].map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => send(prompt)}
                className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            placeholder="Ask about the review, or have it draft comments"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                send(input)
              }
            }}
            className="min-h-10"
          />
          <Button size="icon-sm" aria-label="Send" onClick={() => send(input)}>
            <ArrowUp aria-hidden />
          </Button>
        </div>
      </footer>
    </div>
  )
}

export function DraftFeedbackVariant(props: { variant: FeedbackVariant } & Props) {
  if (props.variant === "A") return <PerPointActions onAddDraft={props.onAddDraft} />
  if (props.variant === "B") return <DraftTray onAddDraft={props.onAddDraft} />
  return <FollowUpChat onAddDraft={props.onAddDraft} />
}
