import {
  parsePullRequestReference,
  shownVisualizationOf,
  SUBAGENT_TOOL,
  type ToolCallPart,
  type TurnPart,
} from "@glass/contracts"
import { cn } from "cn"
import { Array as Arr, Match, Predicate } from "effect"
import { Bot, Brain, Layers, Wrench } from "lucide-react"
import {
  type ComponentProps,
  createContext,
  memo,
  type ReactNode,
  use,
  useCallback,
  useContext,
  useState,
} from "react"
import {
  type Components,
  defaultComponents,
  defaultRemarkPlugins,
  Streamdown,
  useIsCodeFenceIncomplete,
} from "streamdown"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"
import { plural } from "./plural"
import { AskedQuestionLine, isAskUser } from "./AskedQuestion"
import { SentMessage } from "./UserMessage"
import { PullRequestLink } from "./ThreadPullRequest"
import { BrowserLinks } from "./BrowserPane"
import { RequestCard } from "./RequestCard"
import { MermaidDiagram } from "./MermaidDiagram"
import { FileImage, FileLink, localFilePath, remarkLocalFiles } from "./ThreadFiles"
import { Visualization } from "./Visualization"

export const ToolCallView = createContext<
  ((call: typeof ToolCallPart.Type) => ReactNode | null) | null
>(null)

export const BackgroundToolCalls = createContext<ReadonlySet<string>>(new Set())

const builtInView = (call: typeof ToolCallPart.Type) => {
  const visualization = shownVisualizationOf(call)

  return visualization === null ? null : (
    <Visualization id={visualization.id} title={visualization.title} />
  )
}

const useToolCallView = () => {
  const screenView = useContext(ToolCallView)

  return (call: typeof ToolCallPart.Type) => builtInView(call) ?? screenView?.(call) ?? null
}

interface NestedPart {
  readonly part: TurnPart
  readonly index: number
  readonly nested: ReadonlyArray<NestedPart>
}

const NOTHING_NESTED: ReadonlyArray<NestedPart> = []

const nestParts = (parts: ReadonlyArray<TurnPart>): ReadonlyArray<NestedPart> => {
  const calls = new Set(
    parts.flatMap((part) => (Predicate.isTagged(part, "ToolCall") ? [part.toolCallId] : [])),
  )

  const byParent = new Map<string | null, Array<number>>()

  parts.forEach((part, index) => {
    const parent =
      Predicate.isTagged(part, "ToolCall") &&
      part.parentToolCallId !== null &&
      calls.has(part.parentToolCallId)
        ? part.parentToolCallId
        : null

    const siblings = byParent.get(parent)

    if (siblings === undefined) byParent.set(parent, [index])
    else siblings.push(index)
  })

  const under = (parent: string | null): ReadonlyArray<NestedPart> =>
    (byParent.get(parent) ?? []).flatMap((index) => {
      const part = parts[index]

      if (part === undefined) return []

      const id = Predicate.isTagged(part, "ToolCall") ? part.toolCallId : null

      return [{ part, index, nested: id !== null && byParent.has(id) ? under(id) : NOTHING_NESTED }]
    })

  return under(null)
}

type GroupKind = "steps" | "subagents"

type PartRun =
  | { readonly kind: GroupKind; readonly items: Arr.NonEmptyReadonlyArray<NestedPart> }
  | { readonly kind: null; readonly item: NestedPart }

const groupParts = (
  parts: ReadonlyArray<NestedPart>,
  kindOf: (part: TurnPart) => GroupKind | null,
): ReadonlyArray<PartRun> =>
  parts.reduce<Array<PartRun>>((runs, item) => {
    const last = runs.at(-1)
    const kind = kindOf(item.part)

    if (kind === null) runs.push({ kind, item })
    else if (last !== undefined && last.kind === kind)
      runs[runs.length - 1] = { kind, items: [...last.items, item] }
    else runs.push({ kind, items: [item] })

    return runs
  }, [])

const counted = (count: number, noun: string, nouns?: string) =>
  count === 0 ? null : plural(count, noun, nouns)

const toolStatus = {
  running: { label: "Running", line: "running", standing: "running" },
  done: { label: "Done", line: undefined, standing: "done" },
  failed: { label: "Failed", line: "error", standing: "failed" },
  stopped: { label: "Stopped", line: undefined, standing: "stopped" },
  background: { label: "Running in the background", line: "running", standing: "running" },
} as const

export const callStatus = (
  call: typeof ToolCallPart.Type,
  inBackground: ReadonlySet<string>,
): keyof typeof toolStatus =>
  call.status === "done" && inBackground.has(call.toolCallId) ? "background" : call.status

const standingOf = (call: typeof ToolCallPart.Type, inBackground: ReadonlySet<string>) =>
  toolStatus[callStatus(call, inBackground)].standing

export const toolCallsOf = (parts: ReadonlyArray<TurnPart>) =>
  parts.filter((part) => Predicate.isTagged(part, "ToolCall"))

const countWhere = <A,>(items: ReadonlyArray<A>, matches: (item: A) => boolean) =>
  items.filter(matches).length

const stepsTitle = (parts: ReadonlyArray<TurnPart>, inBackground: ReadonlySet<string>) => {
  const calls = toolCallsOf(parts)
  const running = calls.find((call) => call.status === "running")

  const summary = [
    counted(calls.length, "tool call"),
    counted(parts.length - calls.length, "thought"),
    counted(
      countWhere(calls, (call) => callStatus(call, inBackground) === "failed"),
      "failed",
      "failed",
    ),
    counted(
      countWhere(calls, (call) => callStatus(call, inBackground) === "background"),
      "in the background",
      "in the background",
    ),
  ]
    .filter(Predicate.isString)
    .join(", ")

  return `${running === undefined ? "Worked" : `Running ${running.name}`} · ${summary}`
}

const subagentsTitle = (parts: ReadonlyArray<TurnPart>, inBackground: ReadonlySet<string>) => {
  const calls = toolCallsOf(parts)

  return [
    counted(calls.length, "subagent"),
    ...(["running", "done", "failed", "stopped"] as const).map((standing) =>
      counted(
        countWhere(calls, (call) => standingOf(call, inBackground) === standing),
        standing,
        standing,
      ),
    ),
  ]
    .filter(Predicate.isString)
    .join(" · ")
}

const partGroups: Record<
  GroupKind,
  {
    readonly icon: ReactNode
    readonly title: (parts: ReadonlyArray<TurnPart>, inBackground: ReadonlySet<string>) => string
    readonly running: (call: typeof ToolCallPart.Type, inBackground: ReadonlySet<string>) => boolean
  }
> = {
  steps: { icon: <Layers />, title: stepsTitle, running: (call) => call.status === "running" },
  subagents: {
    icon: <Bot />,
    title: subagentsTitle,
    running: (call, inBackground) => standingOf(call, inBackground) === "running",
  },
}

export function TurnParts(props: { parts: ReadonlyArray<TurnPart> }) {
  const toolCallView = useToolCallView()
  const inBackground = useContext(BackgroundToolCalls)

  const kindOf = (part: TurnPart): GroupKind | null => {
    if (Predicate.isTagged(part, "Thinking")) return "steps"

    if (!Predicate.isTagged(part, "ToolCall") || toolCallView(part) !== null) return null

    return part.name === SUBAGENT_TOOL ? "subagents" : "steps"
  }

  return groupParts(nestParts(props.parts), kindOf).map((run) => {
    const [first, ...rest] = run.kind === null ? [run.item] : run.items

    if (run.kind === null || rest.length === 0)
      return <PartView key={first.index} part={first.part} nested={first.nested} />

    const group = partGroups[run.kind]
    const parts = run.items.map(({ part }) => part)

    return (
      <PartGroup
        key={first.index}
        icon={group.icon}
        title={group.title(parts, inBackground)}
        running={toolCallsOf(parts).some((call) => group.running(call, inBackground))}
        items={run.items}
      />
    )
  })
}

function PartGroup(props: {
  icon: ReactNode
  title: string
  running: boolean
  items: ReadonlyArray<NestedPart>
}) {
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={props.running ? "running" : undefined}>
            <TraceIcon>{props.icon}</TraceIcon>
            <TraceTitle>{props.title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2">
          {props.items.map(({ part, index, nested }) => (
            <PartView key={index} part={part} nested={nested} />
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

function FencedCode(props: { code: string; language: string }) {
  const lines = useHighlightedCode(props.code, props.language)

  return (
    <CodeBlock className="rounded-xl border-0 bg-muted dark:bg-muted">
      <CodeBlockHeader>
        <CodeBlockTitle>{props.language}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={props.code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

function MermaidBlock(props: { code: string }) {
  const incomplete = useIsCodeFenceIncomplete()
  const [invalid, setInvalid] = useState(false)
  const onInvalid = useCallback(() => setInvalid(true), [])

  return incomplete || invalid ? (
    <FencedCode code={props.code} language="mermaid" />
  ) : (
    <CodeBlock className="rounded-xl border-0 bg-muted dark:bg-muted">
      <CodeBlockHeader>
        <CodeBlockTitle>mermaid</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={props.code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <div className="m-1.5 mt-3 rounded-lg bg-background p-3">
        <MermaidDiagram source={props.code} onInvalid={onInvalid} />
      </div>
    </CodeBlock>
  )
}

const streamdownLinkClass = "wrap-anywhere font-medium text-primary underline"

function MarkdownLink(props: ComponentProps<typeof defaultComponents.a>) {
  const { href } = props
  const localPath = localFilePath(href)
  const browserLinks = use(BrowserLinks)

  if (localPath !== null) return <FileLink text={localPath}>{props.children}</FileLink>

  if (href !== undefined && browserLinks?.policy.opensLink(href) === true)
    return (
      <a
        className={cn(streamdownLinkClass, props.className)}
        data-streamdown="link"
        href={href}
        rel="noreferrer"
        target="_blank"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey) return

          event.preventDefault()
          browserLinks.open(href)
        }}
      >
        {props.children}
      </a>
    )

  const pullRequest = href === undefined ? null : parsePullRequestReference(href)

  if (href === undefined || pullRequest === null) return <defaultComponents.a {...props} />

  return (
    <PullRequestLink
      className={cn(streamdownLinkClass, props.className)}
      data-streamdown="link"
      href={href}
      pullRequest={pullRequest}
    >
      {props.children}
    </PullRequestLink>
  )
}

function MarkdownImage(props: ComponentProps<typeof defaultComponents.img>) {
  const localPath = localFilePath(props.src)

  return localPath === null ? (
    <defaultComponents.img {...props} />
  ) : (
    <FileImage path={localPath} alt={props.alt} />
  )
}

const markdownComponents: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  table: ({ node: _node, ...props }) => (
    <div className="thread-markdown-table">
      <table {...props} />
    </div>
  ),
  code: (props) => {
    const language = /language-(\S+)/.exec(props.className ?? "")?.[1] ?? ""

    if (!Predicate.isString(props.children)) return <defaultComponents.code {...props} />

    if (!("data-block" in props))
      return (
        <FileLink text={props.children}>
          <defaultComponents.code {...props} />
        </FileLink>
      )

    return language === "mermaid" ? (
      <MermaidBlock code={props.children} />
    ) : (
      <FencedCode code={props.children} language={language} />
    )
  },
}

const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkLocalFiles]

function ThreadMarkdown(props: { text: string }) {
  return (
    <Streamdown
      className="thread-markdown text-sm"
      components={markdownComponents}
      remarkPlugins={remarkPlugins}
    >
      {props.text}
    </Streamdown>
  )
}

const PartView = memo(function PartView(props: {
  part: TurnPart
  nested: ReadonlyArray<NestedPart>
}) {
  const toolCallView = useToolCallView()
  const inBackground = useContext(BackgroundToolCalls)

  return Match.value(props.part).pipe(
    Match.tagsExhaustive({
      Text: ({ text }) => <ThreadMarkdown text={text} />,
      Steer: ({ message, images, context }) => (
        <SentMessage message={message} images={images} context={context} steered />
      ),
      Thinking: ({ text }) => (
        <Trace>
          <TraceCollapsible>
            <TraceCollapsibleTrigger>
              <TraceLine>
                <TraceIcon>
                  <Brain />
                </TraceIcon>
                <TraceTitle>Thinking</TraceTitle>
              </TraceLine>
            </TraceCollapsibleTrigger>
            <TraceCollapsibleContent className="whitespace-pre-wrap">
              {text}
            </TraceCollapsibleContent>
          </TraceCollapsible>
        </Trace>
      ),
      ToolCall: (call) => {
        const shown = toolCallView(call)

        if (shown !== null) return shown

        if (isAskUser(call.name)) return <AskedQuestionLine call={call} />

        const shownStatus = callStatus(call, inBackground)
        const status = toolStatus[shownStatus]

        return (
          <Trace>
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine status={status.line}>
                  <TraceIcon>
                    <Wrench />
                  </TraceIcon>
                  <TraceTitle className="flex items-center gap-1">
                    <span className="sr-only">{status.label}: </span>
                    <span className="shrink-0 font-medium text-foreground">{call.name}</span>{" "}
                    <span className="truncate font-mono text-xs">{call.inputSummary}</span>
                    {shownStatus === "background" && (
                      <span aria-hidden className="shrink-0 text-xs">
                        · in the background
                      </span>
                    )}
                  </TraceTitle>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent className="flex flex-col gap-2">
                <CodeBlock size="sm">
                  <CodeBlockContent wrap className="max-h-64">
                    {call.input}
                  </CodeBlockContent>
                </CodeBlock>
                {props.nested.length > 0 && (
                  <div className="flex flex-col gap-1 border-l pl-3">
                    {props.nested.map(({ part, index, nested }) => (
                      <PartView key={index} part={part} nested={nested} />
                    ))}
                  </div>
                )}
                {call.output !== null && (
                  <CodeBlock size="sm">
                    <CodeBlockContent
                      wrap
                      className={cn("max-h-80", call.status === "failed" && "text-destructive")}
                    >
                      {call.output}
                    </CodeBlockContent>
                  </CodeBlock>
                )}
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </Trace>
        )
      },
      PermissionRequest: (request) => <RequestCard part={request} />,
      Question: (question) => <RequestCard part={question} />,
    }),
  )
})
