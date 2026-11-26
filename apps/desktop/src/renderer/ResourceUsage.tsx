import type { ResourceUsage as Usage } from "@glass/contracts/desktop"
import { cn } from "cn"
import { Cpu, MemoryStick } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { localStorageBooleanAtom } from "./localStorageBooleanAtom"

const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

const formatCPU = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${percent.format(value)}%`

const formatMemory = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) return "—"

  if (bytes >= 1024 ** 3) return `${percent.format(bytes / 1024 ** 3)} GB`

  return `${Math.round(bytes / 1024 ** 2)} MB`
}

export const titleStripResourceUsageAtom = localStorageBooleanAtom("glass.titleStripResourceUsage")

type Kind = "cpu" | "ram"

type TrendPoint = Readonly<Record<Kind, number>>

const readings = {
  cpu: {
    icon: Cpu,
    label: "CPU",
    color: "text-[#6251b7] dark:text-[#ada6ff]",
    of: (usage: Usage) => usage.cpuPercent,
    format: formatCPU,
    minSpan: 10,
  },
  ram: {
    icon: MemoryStick,
    label: "RAM",
    color: "text-[#116e53] dark:text-[#6bd6b0]",
    of: (usage: Usage) => usage.memoryBytes,
    format: formatMemory,
    minSpan: 64 * 1024 ** 2,
  },
}

const kinds = ["cpu", "ram"] as const

const describe = (usage: Usage | null) =>
  kinds
    .map((kind) => {
      const { label, of, format } = readings[kind]

      return `${label} ${format(usage && of(usage))}`
    })
    .join(", ")

const trendLength = 30

export function useResourceUsage() {
  const [samples, setSamples] = useState<{
    usage: Usage | null
    trend: ReadonlyArray<TrendPoint>
  }>({ usage: null, trend: [] })

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const sample = async () => {
      let next: Usage | null

      try {
        next = await window.glass.resourceUsage()
      } catch {
        next = null
      }

      if (stopped) return
      setSamples(({ trend }) => ({
        usage: next,
        trend:
          next === null || next.memoryBytes === null
            ? trend
            : [...trend.slice(1 - trendLength), { cpu: next.cpuPercent, ram: next.memoryBytes }],
      }))
      timer = setTimeout(() => void sample(), 2000)
    }

    void sample()

    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])

  return samples
}

const sparkWidth = 40

const sparkHeight = 12

const sparkPoints = (values: ReadonlyArray<number>, minSpan: number) => {
  const low = Math.min(...values)
  const span = Math.max(Math.max(...values) - low, minSpan)
  const step = sparkWidth / (values.length - 1)

  return values
    .map((value, index) => {
      const y = sparkHeight - 1 - ((value - low) / span) * (sparkHeight - 2)

      return `${(index * step).toFixed(1)},${y.toFixed(1)}`
    })
    .join(" ")
}

function Sparkline(props: { values: ReadonlyArray<number>; minSpan: number }) {
  return (
    <svg
      viewBox={`0 0 ${sparkWidth} ${sparkHeight}`}
      width={sparkWidth}
      height={sparkHeight}
      className="shrink-0 overflow-visible"
      aria-hidden
    >
      {props.values.length > 1 && (
        <polyline
          points={sparkPoints(props.values, props.minSpan)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

function Reading(props: {
  kind: Kind
  usage: Usage | null
  className: string
  trend?: ReadonlyArray<TrendPoint>
}) {
  const { kind, usage, trend } = props
  const { icon: Icon, label, color, of, format, minSpan } = readings[kind]

  return (
    <span className={cn("flex items-center gap-1.5", props.className)}>
      <Icon className={cn("size-3.5 shrink-0", color)} strokeWidth={1.65} aria-hidden />
      {trend === undefined ? (
        <span>{label}</span>
      ) : (
        <span className={cn("hidden @min-[15rem]:block", color)}>
          <Sparkline values={trend.map((point) => point[kind])} minSpan={minSpan} />
        </span>
      )}
      <span className="ml-auto text-foreground">{format(usage && of(usage))}</span>
    </span>
  )
}

function ResourceUsagePopover(props: {
  usage: Usage | null
  side: "top" | "bottom"
  sideOffset: number
  className: string
  children: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Show Glass resource usage"
        aria-description={describe(props.usage)}
        className={cn(
          "flex items-center gap-3 text-[11px] text-muted-foreground tabular-nums",
          props.className,
        )}
      >
        {props.children}
      </PopoverTrigger>
      <PopoverContent
        side={props.side}
        align="end"
        sideOffset={props.sideOffset}
        className="w-72 gap-3 p-4"
      >
        <ResourceUsagePanel usage={props.usage} />
      </PopoverContent>
    </Popover>
  )
}

export function ResourceUsage() {
  const { usage } = useResourceUsage()

  return (
    <ResourceUsagePopover
      usage={usage}
      side="top"
      sideOffset={10}
      className="h-6 rounded px-1.5 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Reading kind="cpu" usage={usage} className="w-[84px]" />
      <Reading kind="ram" usage={usage} className="w-[104px]" />
    </ResourceUsagePopover>
  )
}

export function TitleStripResourceUsage() {
  const { usage, trend } = useResourceUsage()

  return (
    <div className="@container ml-auto flex min-w-0 flex-[0_1_15rem] justify-end">
      <ResourceUsagePopover
        usage={usage}
        side="bottom"
        sideOffset={6}
        className="h-7 rounded-md px-2 outline-none @max-[10rem]:hidden hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/5"
      >
        <Reading
          kind="cpu"
          usage={usage}
          trend={trend}
          className="w-[54px] @min-[15rem]:w-[96px]"
        />
        <Reading
          kind="ram"
          usage={usage}
          trend={trend}
          className="w-[68px] @min-[15rem]:w-[112px]"
        />
      </ResourceUsagePopover>
    </div>
  )
}

function ResourceUsagePanel(props: { usage: Usage | null }) {
  const { usage } = props
  const cpu = formatCPU(usage?.cpuPercent)
  const memory = formatMemory(usage?.memoryBytes)

  return (
    <>
      <div>
        <PopoverTitle>Glass resource usage</PopoverTitle>
        <PopoverDescription className="mt-1 text-xs">
          {usage === null ? "Waiting for resource readings…" : "Live · updates every 2 seconds"}
        </PopoverDescription>
      </div>
      <div className="grid grid-cols-2 gap-4 border-y py-3 tabular-nums">
        <div>
          <p className="text-[11px] text-muted-foreground">CPU</p>
          <p className="mt-1 text-xl font-medium">{cpu}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">Memory</p>
          <p className="mt-1 text-xl font-medium">{memory}</p>
        </div>
      </div>
      {usage !== null && (
        <table aria-label="Resource usage by process" className="w-full text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pb-2 text-left font-normal" scope="col">
                Process
              </th>
              <th className="pb-2 text-right font-normal" scope="col">
                CPU
              </th>
              <th className="pb-2 text-right font-normal" scope="col">
                RAM
              </th>
            </tr>
          </thead>
          <tbody>
            {usage.processes.map((process) => (
              <tr key={process.name}>
                <th className="py-1.5 text-left font-normal" scope="row">
                  {process.name}
                </th>
                <td className="text-right">{formatCPU(process.cpuPercent)}</td>
                <td className="text-right">{formatMemory(process.memoryBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        CPU is a share of this computer’s total capacity. RAM leaves out memory shared between
        processes on Windows, but can include it elsewhere. External agents aren’t included.
      </p>
    </>
  )
}
