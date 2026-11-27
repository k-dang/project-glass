import type { ResourceProcess, ResourceUsage } from "@glass/contracts/desktop"
import type { MemoryInfo, ProcessMetric } from "electron"

interface Metric extends Pick<ProcessMetric, "type" | "name" | "cpu"> {
  readonly memory?: MemoryInfo
}

const processNames = ["Main", "Renderer", "Backend", "GPU", "Other"] as const

function processName(metric: Metric): ResourceProcess {
  if (metric.name === "Glass backend") return "Backend"

  if (metric.type === "Browser") return "Main"

  if (metric.type === "Tab") return "Renderer"

  if (metric.type === "GPU") return "GPU"

  return "Other"
}

export function summarizeResourceUsage(metrics: ReadonlyArray<Metric>): ResourceUsage {
  const groups: Record<ResourceProcess, { cpuPercent: number; memoryBytes: number | null }> = {
    Main: { cpuPercent: 0, memoryBytes: 0 },
    Renderer: { cpuPercent: 0, memoryBytes: 0 },
    Backend: { cpuPercent: 0, memoryBytes: 0 },
    GPU: { cpuPercent: 0, memoryBytes: 0 },
    Other: { cpuPercent: 0, memoryBytes: 0 },
  }

  for (const metric of metrics) {
    const group = groups[processName(metric)]

    group.cpuPercent += metric.cpu.percentCPUUsage
    group.memoryBytes =
      metric.memory === undefined || group.memoryBytes === null
        ? null
        : group.memoryBytes + (metric.memory.privateBytes ?? metric.memory.workingSetSize) * 1024
  }

  const processes = processNames.map((name) => ({ name, ...groups[name] }))

  return {
    cpuPercent: processes.reduce((sum, process) => sum + process.cpuPercent, 0),
    memoryBytes: processes.reduce<number | null>(
      (sum, process) =>
        sum === null || process.memoryBytes === null ? null : sum + process.memoryBytes,
      0,
    ),
    processes,
  }
}
