import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { StorageGroup, StorageItem } from "@glass/contracts"
import { AsyncResult, Atom } from "effect/reactivity"
import { ChevronRight } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Backend, backendRuntime } from "./backend"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"
import { SettingsSection } from "./SettingsSection"

const breakdownAtom = backendRuntime
  .atom(Backend.use((backend) => backend.GetStorageBreakdown()))
  .pipe(Atom.setIdleTTL("5 minutes"))

const decimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

const formatBytes = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${decimal.format(bytes / 1024 ** 3)} GB`

  if (bytes >= 1024 ** 2) return `${decimal.format(bytes / 1024 ** 2)} MB`

  if (bytes >= 1024) return `${decimal.format(bytes / 1024)} KB`

  return `${bytes} B`
}

const formatShare = (share: number) => (share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`)

const groups = {
  agents: { label: "Agents", color: "var(--viewed)" },
  reviews: { label: "Reviews", color: "var(--added)" },
  activity: { label: "Activity", color: "var(--modified)" },
  toDos: { label: "To-dos", color: "color-mix(in srgb, var(--viewed) 50%, var(--added))" },
  internals: { label: "Glass internals", color: "var(--muted-foreground)" },
  overhead: {
    label: "SQLite overhead",
    color: "color-mix(in srgb, var(--muted-foreground) 45%, var(--card))",
  },
} satisfies Record<StorageGroup, { label: string; color: string }>

const variants = {
  group: {
    label: "w-44 shrink-0 font-medium",
    track: "h-2 bg-muted",
    fill: "",
    figure: "",
  },
  item: {
    label: "w-44 shrink-0 truncate font-mono",
    track: "h-1",
    fill: "opacity-60",
    figure: "text-muted-foreground",
  },
}

interface Row {
  readonly label: string
  readonly color: string
  readonly bytes: number
  readonly items: ReadonlyArray<StorageItem>
}

const sumBytes = (items: ReadonlyArray<{ readonly bytes: number }>) =>
  items.reduce((sum, { bytes }) => sum + bytes, 0)

const largestFirst = <Sized extends { readonly bytes: number }>(
  items: ReadonlyArray<Sized>,
): ReadonlyArray<Sized> =>
  items.filter(({ bytes }) => bytes > 0).toSorted((left, right) => right.bytes - left.bytes)

const rowsOf = (items: ReadonlyArray<StorageItem>) =>
  largestFirst(
    Object.entries(groups).map(([group, { label, color }]) => {
      const inGroup = items.filter((item) => item.group === group)

      return { label, color, bytes: sumBytes(inGroup), items: largestFirst(inGroup) }
    }),
  )

function UsageCells(props: {
  label: string
  bytes: number
  share: number
  color: string
  variant: keyof typeof variants
}) {
  const variant = variants[props.variant]

  return (
    <>
      <span className={variant.label}>{props.label}</span>
      <span className={`min-w-0 flex-1 overflow-hidden rounded-full ${variant.track}`} aria-hidden>
        <span
          className={`block size-full origin-left rounded-full ${variant.fill}`}
          style={{ backgroundColor: props.color, transform: `scaleX(${props.share})` }}
        />
      </span>
      <span className="w-10 text-right text-muted-foreground">{formatShare(props.share)}</span>
      <span className={`w-16 text-right ${variant.figure}`}>{formatBytes(props.bytes)}</span>
    </>
  )
}

function StorageRow(props: { row: Row; total: number; index: number }) {
  const { label, color, bytes, items } = props.row

  return (
    <Collapsible
      defaultOpen={props.index === 0}
      className="enter-motion border-b"
      style={{ transitionDelay: `${props.index * 32}ms` }}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-3 py-3 text-left text-sm tabular-nums">
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-panel-open:rotate-90"
          aria-hidden
        />
        <UsageCells
          label={label}
          bytes={bytes}
          share={bytes / props.total}
          color={color}
          variant="group"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0">
        <ul className="pb-3">
          {items.map((item) => (
            <li
              key={item.name}
              className="flex items-center gap-3 py-1.5 pl-6.5 text-xs tabular-nums"
              title={item.name}
            >
              <UsageCells
                label={item.name}
                bytes={item.bytes}
                share={item.bytes / props.total}
                color={color}
                variant="item"
              />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function StorageDetails({ items }: { items: ReadonlyArray<StorageItem> }) {
  const rows = rowsOf(items)
  const total = sumBytes(items)
  const [largest] = rows

  return (
    <div className="flex flex-col gap-5">
      <p className="text-2xl font-medium tracking-tight tabular-nums">
        {formatBytes(total)} on disk
        {largest !== undefined && (
          <span className="text-muted-foreground"> · largest is {largest.label}</span>
        )}
      </p>
      <div className="flex flex-col">
        {rows.map((row, index) => (
          <StorageRow key={row.label} row={row} total={total} index={index} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Sizes include indexes. SQLite overhead is space SQLite keeps for recent writes, plus free
        space it will reuse.
      </p>
    </div>
  )
}

export function StorageSettings() {
  const result = useAtomValue(breakdownAtom)
  const reload = useAtomRefresh(breakdownAtom)

  const details = AsyncResult.builder(result)
    .onInitialOrWaiting(() => <p className="text-sm text-muted-foreground">Measuring storage…</p>)
    .onFailure((cause) => (
      <ProblemAlert problem={problemOf(cause)} action={{ label: "Try again", run: reload }} />
    ))
    .onSuccess((items) => <StorageDetails items={items} />)
    .render()

  return (
    <SettingsSection title="Storage" description="What Glass's database takes up on this computer.">
      {details}
    </SettingsSection>
  )
}
