import type { TourBeforeAfter as BeforeAfter, TourCodeTarget } from "@glass/contracts"
import { cn } from "cn"
import { fileName } from "./fileName"
import { LineCounts } from "./LineCounts"

const looks = {
  unchanged: { sign: "", signTone: "", row: "border-transparent text-muted-foreground" },
  added: {
    sign: "+",
    signTone: "text-added",
    row: "border-added bg-[color-mix(in_oklch,var(--added)_11%,transparent)]",
  },
  removed: {
    sign: "−",
    signTone: "text-deleted",
    row: "border-deleted bg-[color-mix(in_oklch,var(--deleted)_11%,transparent)]",
  },
}

const countOf = (beforeAfter: BeforeAfter, change: "added" | "removed") =>
  beforeAfter.lines.filter((line) => line.change === change).length

const locationOf = ({ path, startLine }: TourCodeTarget) => `${fileName(path)}:${startLine}`

function Line(props: {
  line: BeforeAfter["lines"][number]
  onSelect: (target: TourCodeTarget) => void
}) {
  const { line } = props
  const { target } = line
  const look = looks[line.change]

  const content = (
    <>
      <span aria-hidden className={cn("w-3 shrink-0 text-center", look.signTone)}>
        {look.sign}
      </span>
      <span
        className="min-w-0 flex-1 wrap-anywhere"
        style={{ paddingInlineStart: `${line.depth * 14}px` }}
      >
        {line.text}
      </span>
    </>
  )

  const row = cn(
    "flex w-full gap-1.5 border-l-2 py-0.75 pr-2.5 pl-1.5 text-left font-mono text-xs leading-4.5",
    look.row,
  )

  return (
    <li>
      {target === null ? (
        <div className={row}>{content}</div>
      ) : (
        <button
          type="button"
          title={`${target.path}:${target.startLine} (${target.side})`}
          aria-label={`${line.text}, ${line.change}. Show ${locationOf(target)}`}
          className={cn(
            row,
            "cursor-pointer hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          )}
          onClick={() => props.onSelect(target)}
        >
          {content}
          <span className="shrink-0 pt-px text-[10px] text-muted-foreground">
            {locationOf(target)}
          </span>
        </button>
      )}
    </li>
  )
}

export function TourBeforeAfter(props: {
  beforeAfter: BeforeAfter
  onSelect: (target: TourCodeTarget) => void
}) {
  const { beforeAfter } = props

  return (
    <section
      className="min-w-0 overflow-clip rounded-[7px] border bg-background"
      aria-label={`Before / after: ${beforeAfter.title}`}
    >
      <header className="flex items-center gap-2 border-b px-2.5 py-2 text-xs font-medium">
        <h3 className="shrink-0">Before / after</h3>
        <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">
          {beforeAfter.title}
        </span>
        <LineCounts
          additions={countOf(beforeAfter, "added")}
          deletions={countOf(beforeAfter, "removed")}
        />
      </header>
      <ol>
        {beforeAfter.lines.map((line, index) => (
          <Line key={index} line={line} onSelect={props.onSelect} />
        ))}
      </ol>
    </section>
  )
}
