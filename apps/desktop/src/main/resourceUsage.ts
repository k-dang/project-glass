import type { ResourceProcess, ResourceUsage } from "@glass/contracts/desktop"
import type { MemoryInfo, ProcessMetric } from "electron"

// Electron omits memory on Linux despite declaring it as required in ProcessMetric.
interface Metric extends Pick<ProcessMetric, "type" | "name" | "cpu"> {
  readonly memory?: MemoryInfo
}

export function summarizeResourceUsage(metrics: ReadonlyArray<Metric>): ResourceUsage {
  const groups: Record<ResourceProcess, { cpuPercent: number; memoryBytes: number | null }> = {
    Main: { cpuPercent: 0, memoryBytes: 0 },
    Renderer: { cpuPercent: 0, memoryBytes: 0 },
    Backend: { cpuPercent: 0, memoryBytes: 0 },
    "GPU / other": { cpuPercent: 0, memoryBytes: 0 },
  }

  for (const metric of metrics) {
    let name: ResourceProcess = "GPU / other"

    if (metric.name === "Glass backend") name = "Backend"
    else if (metric.type === "Browser") name = "Main"
    else if (metric.type === "Tab") name = "Renderer"

    const group = groups[name]

    // getAppMetrics already expresses CPU as a share of all logical processors.
    group.cpuPercent += metric.cpu.percentCPUUsage
    group.memoryBytes =
      metric.memory === undefined || group.memoryBytes === null
        ? null
        : group.memoryBytes + metric.memory.workingSetSize * 1024
  }

  const processes = (["Main", "Renderer", "Backend", "GPU / other"] as const).map((name) => ({
    name,
    ...groups[name],
  }))

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
