import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { ActivityKind, ActivityStamp } from "@glass/contracts"
import { DateTime, Effect, Schema } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useId, useState } from "react"
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts"
import { Backend, backendRuntime } from "./backend"
import { SectionLink } from "./Lists"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"
import { daysAgo, daysBetween } from "./recency"

const doneKinds = ["ReviewSubmitted", "ReplySent", "AgentStarted", "ToDoDone"] as const satisfies [
  ActivityKind,
  ...Array<ActivityKind>,
]

type DoneKind = (typeof doneKinds)[number]

const isDone = Schema.is(Schema.Literals(doneKinds))

const series: Record<DoneKind, { label: string; color: string }> = {
  ReviewSubmitted: { label: "Reviews", color: "var(--added)" },
  ReplySent: { label: "Replies", color: "var(--viewed)" },
  AgentStarted: { label: "Agents started", color: "var(--modified)" },
  ToDoDone: { label: "To-dos done", color: "var(--muted-foreground)" },
}

const ranges = [7, 30, 90] as const

type Range = (typeof ranges)[number]

const longestRange = Math.max(...ranges)

type ActivityDay = Record<DoneKind, number> & { readonly day: number }

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" })

const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })

const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
})

export const activityByDay = (
  stamps: ReadonlyArray<ActivityStamp>,
  days: number,
  now: Date,
): Array<ActivityDay> => {
  const first = daysAgo(days - 1, now)

  const rows = Array.from({ length: days }, (_, offset) => ({
    day: daysAgo(days - 1 - offset, now).getTime(),
    ReviewSubmitted: 0,
    ReplySent: 0,
    AgentStarted: 0,
    ToDoDone: 0,
  }))

  for (const { kind, occurredAt } of stamps) {
    const row = rows[daysBetween(first, DateTime.toDate(occurredAt))]

    if (row !== undefined && isDone(kind)) row[kind] += 1
  }

  return rows
}

const activityChartAtom = backendRuntime
  .atom(
    Effect.gen(function* () {
      const now = DateTime.toDate(yield* DateTime.now)

      const stamps = yield* Backend.use((backend) =>
        backend.ListActivityStamps({
          since: DateTime.fromDateUnsafe(daysAgo(longestRange - 1, now)),
          kinds: doneKinds,
        }),
      )

      return { stamps, now }
    }),
  )
  .pipe(Atom.keepAlive, Atom.swr({ staleTime: 0 }))

export function ActivityChart() {
  const id = useId()
  const [days, setDays] = useState<Range>(30)
  const result = useAtomValue(activityChartAtom)
  const retry = useAtomRefresh(activityChartAtom)

  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={id} className="text-base font-semibold">
          Activity
        </h2>
        <ToggleGroup
          aria-label="Days of Activity"
          variant="outline"
          size="sm"
          spacing={0}
          value={[String(days)]}
          onValueChange={([chosen]) => {
            const range = ranges.find((option) => String(option) === chosen)

            if (range !== undefined) setDays(range)
          }}
        >
          {ranges.map((range) => (
            <ToggleGroupItem key={range} value={String(range)}>
              {range} days
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <SectionLink link={{ to: "/activity" }}>Go to Activity</SectionLink>
      </div>
      <div className="rounded-xl border bg-card p-4">
        {AsyncResult.builder(result)
          .onSuccess(({ stamps, now }) => (
            <DailyActivity rows={activityByDay(stamps, days, now)} days={days} />
          ))
          .onFailure((cause) => (
            <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: retry }} />
          ))
          .orElse(() => (
            <output className="flex h-56 items-center justify-center text-sm text-muted-foreground">
              Loading your Activity…
            </output>
          ))}
      </div>
    </section>
  )
}

function DailyActivity(props: { rows: Array<ActivityDay>; days: Range }) {
  const totals = doneKinds.map((kind) => ({
    kind,
    total: props.rows.reduce((sum, row) => sum + row[kind], 0),
  }))

  if (totals.every(({ total }) => total === 0)) {
    return (
      <p className="flex h-56 flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
        <span className="font-medium text-foreground">
          Nothing done in the last {props.days} days
        </span>
        Submit a Review, send a Reply, start an Agent, or finish a To-do to see it here.
      </p>
    )
  }

  const tick = props.days <= 7 ? weekday : monthDay

  return (
    <div className="flex flex-col gap-3">
      <ChartContainer className="aspect-auto h-48 w-full">
        <BarChart data={props.rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="day"
            tickFormatter={(day: number) => tick.format(day)}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={16}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={24} />
          <Tooltip
            content={<ChartTooltipContent labelFormatter={(day) => fullDate.format(Number(day))} />}
          />
          {doneKinds.map((kind) => (
            <Bar
              key={kind}
              dataKey={kind}
              name={series[kind].label}
              stackId="activity"
              fill={series[kind].color}
            />
          ))}
        </BarChart>
      </ChartContainer>
      <ul aria-label="Activity totals" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {totals.map(({ kind, total }) => (
          <li key={kind} className="flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden
              className="size-2.5 rounded-[2px]"
              style={{ background: series[kind].color }}
            />
            {series[kind].label}{" "}
            <span className="font-semibold text-foreground tabular-nums">{total}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
