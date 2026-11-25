import { useAtomValue } from "@effect/atom-react"
import { ASK_USER_TOOL, AskedUser, type InboxItems, type ToolCallPart } from "@glass/contracts"
import { Option, Schema } from "effect"
import { CircleHelp } from "lucide-react"
import { AsyncResult, Atom } from "effect/reactivity"
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { watchedInboxAtom } from "./inboxArea"
import { questionsOf } from "./inboxItem"

const openQuestionIdsAtom = Atom.make((get): Option.Option<ReadonlySet<string>> =>
  Option.map(
    AsyncResult.value(get(watchedInboxAtom)),
    (items: InboxItems) => new Set(items.flatMap(questionsOf).map(({ id }) => id)),
  ),
)

export const isAskUser = (name: string) => name === ASK_USER_TOOL

const AskedInput = Schema.Struct({ question: Schema.String })

const askedQuestionOf = Schema.decodeUnknownOption(Schema.fromJsonString(AskedInput))

const askedUserOf = Schema.decodeUnknownOption(Schema.fromJsonString(AskedUser))

const askedIdOf = (output: string | null) =>
  output === null
    ? null
    : Option.getOrNull(Option.map(askedUserOf(output), ({ questionId }) => questionId))

export function AskedQuestionLine(props: { call: typeof ToolCallPart.Type }) {
  const open = useAtomValue(openQuestionIdsAtom)

  const question = Option.match(askedQuestionOf(props.call.input), {
    onNone: () => props.call.inputSummary,
    onSome: ({ question: asked }) => asked,
  })

  const id = askedIdOf(props.call.output)

  const waiting = id !== null && Option.exists(open, (ids) => ids.has(id))

  const status =
    props.call.status === "failed" ? "Not asked" : waiting ? "Waiting in the Inbox" : null

  return (
    <Trace>
      <TraceLine status={props.call.status === "failed" ? "error" : undefined}>
        <TraceIcon>
          <CircleHelp />
        </TraceIcon>
        <TraceTitle className="flex flex-wrap items-baseline gap-x-2 whitespace-normal">
          <span className="font-medium text-foreground">Asked: {question}</span>
          {status !== null && <span className="text-xs">{status}</span>}
        </TraceTitle>
      </TraceLine>
    </Trace>
  )
}
