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

const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

const formatCPU = (value: number | undefined) =>
  value === undefined ? "—" : `${percent.format(value)}%`

const formatMemory = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) return "—"

  if (bytes >= 1024 ** 3) return `${percent.format(bytes / 1024 ** 3)} GB`

  return `${Math.round(bytes / 1024 ** 2)} MB`
}

const readings = {
  cpu: { icon: Cpu, label: "CPU", color: "text-[#6251b7] dark:text-[#ada6ff]" },
  ram: { icon: MemoryStick, label: "RAM", color: "text-[#116e53] dark:text-[#6bd6b0]" },
}

function Reading(props: { kind: "cpu" | "ram"; value: ReactNode; className?: string }) {
  const { icon: Icon, label, color } = readings[props.kind]

  return (
    <span className={cn("flex items-center gap-1.5", props.className)}>
      <Icon className={cn("size-3.5 shrink-0", color)} strokeWidth={1.65} aria-hidden />
      <span>{label}</span>
      <span className="ml-auto text-foreground">{props.value}</span>
    </span>
  )
}

export function useResourceUsage() {
  const [usage, setUsage] = useState<Usage | null>(null)

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
      setUsage(next)
      timer = setTimeout(() => void sample(), 2000)
    }

    void sample()

    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [])

  return usage
}

export function ResourceReadings(props: { usage: Usage | null; className?: string }) {
  return (
    <span className={cn("flex items-center gap-3 tabular-nums", props.className)}>
      <Reading kind="cpu" value={formatCPU(props.usage?.cpuPercent)} className="w-[84px]" />
      <Reading kind="ram" value={formatMemory(props.usage?.memoryBytes)} className="w-[104px]" />
    </span>
  )
}

export function ResourceUsage() {
  const usage = useResourceUsage()

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Show Glass resource usage"
        aria-description={`CPU ${formatCPU(usage?.cpuPercent)}, RAM ${formatMemory(usage?.memoryBytes)}`}
        className="flex h-6 items-center rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ResourceReadings usage={usage} />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={10} className="w-72 gap-3 p-4">
        <ResourceUsagePanel usage={usage} />
      </PopoverContent>
    </Popover>
  )
}

export function ResourceUsagePanel(props: { usage: Usage | null }) {
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
        CPU is a share of this computer’s total capacity. RAM can include memory shared between
        processes. External agents aren’t included.
      </p>
    </>
  )
}
