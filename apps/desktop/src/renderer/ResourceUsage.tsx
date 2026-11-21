import type { ResourceUsage as Usage } from "@glass/contracts/desktop"
import { Cpu, MemoryStick } from "lucide-react"
import { useEffect, useState } from "react"
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

export function ResourceUsage(props: { look?: "footer" | "pill" | "meter" | "row"; side?: "top" | "bottom" | "right" } = {}) {
  const look = props.look ?? "footer"
  const usage = useResourceUsage()
  const cpu = formatCPU(usage?.cpuPercent)
  const memory = formatMemory(usage?.memoryBytes)

  return (
    <Popover>
      {look === "footer" && (
      <PopoverTrigger
        aria-label="Show Glass resource usage"
        aria-description={`CPU ${cpu}, RAM ${memory}`}
        className="flex h-6 items-center gap-3 rounded px-1.5 text-[11px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="flex w-[84px] items-center gap-1.5">
          <Cpu
            className="size-3.5 shrink-0 text-[#6251b7] dark:text-[#ada6ff]"
            strokeWidth={1.65}
            aria-hidden
          />
          <span>CPU</span>
          <span className="ml-auto text-foreground">{cpu}</span>
        </span>
        <span className="flex w-[104px] items-center gap-1.5">
          <MemoryStick
            className="size-3.5 shrink-0 text-[#116e53] dark:text-[#6bd6b0]"
            strokeWidth={1.65}
            aria-hidden
          />
          <span>RAM</span>
          <span className="ml-auto text-foreground">{memory}</span>
        </span>
      </PopoverTrigger>
      )}
      {look === "pill" && (
        <PopoverTrigger
          aria-label="Show Glass resource usage"
          className="flex h-7 items-center gap-2.5 rounded-full border bg-background/60 px-2.5 text-[11px] tabular-nums text-muted-foreground shadow-xs [app-region:no-drag] hover:text-foreground"
        >
          <span className="flex items-center gap-1">
            <Cpu className="size-3.5 text-[#6251b7] dark:text-[#ada6ff]" strokeWidth={1.65} aria-hidden />
            <span className="text-foreground">{cpu}</span>
          </span>
          <span className="h-3 w-px bg-border" />
          <span className="flex items-center gap-1">
            <MemoryStick className="size-3.5 text-[#116e53] dark:text-[#6bd6b0]" strokeWidth={1.65} aria-hidden />
            <span className="text-foreground">{memory}</span>
          </span>
        </PopoverTrigger>
      )}
      {look === "meter" && (
        <PopoverTrigger
          aria-label={`Glass resource usage: CPU ${cpu}, RAM ${memory}`}
          title={`CPU ${cpu} · RAM ${memory}`}
          className="flex w-9 flex-col items-center gap-1 rounded-lg py-1.5 text-[9px] tabular-nums text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
        >
          <span className="flex h-6 items-end gap-0.5">
            <span className="relative h-full w-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <span
                className="absolute inset-x-0 bottom-0 rounded-full bg-[#6251b7] dark:bg-[#ada6ff]"
                style={{ height: `${Math.max(8, Math.min(100, (usage?.cpuPercent ?? 0) * 4))}%` }}
              />
            </span>
            <span className="relative h-full w-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <span
                className="absolute inset-x-0 bottom-0 rounded-full bg-[#116e53] dark:bg-[#6bd6b0]"
                style={{ height: `${Math.min(100, ((usage?.memoryBytes ?? 0) / 2 ** 31) * 100)}%` }}
              />
            </span>
          </span>
          <span>{cpu}</span>
        </PopoverTrigger>
      )}
      {look === "row" && (
        <PopoverTrigger
          aria-label="Show Glass resource usage"
          className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <span className="flex items-center gap-1.5">
            <Cpu className="size-3.5 text-[#6251b7] dark:text-[#ada6ff]" strokeWidth={1.65} aria-hidden />
            CPU <span className="text-foreground">{cpu}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <MemoryStick className="size-3.5 text-[#116e53] dark:text-[#6bd6b0]" strokeWidth={1.65} aria-hidden />
            RAM <span className="text-foreground">{memory}</span>
          </span>
        </PopoverTrigger>
      )}
      <PopoverContent side={props.side ?? "top"} align="end" sideOffset={10} className="w-72 gap-3 p-4">
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
      </PopoverContent>
    </Popover>
  )
}
