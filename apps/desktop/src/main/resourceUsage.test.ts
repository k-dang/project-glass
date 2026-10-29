import type { ProcessMetric } from "electron"
import { expect, it } from "vite-plus/test"
import { summarizeResourceUsage } from "./resourceUsage"

const metric = (type: ProcessMetric["type"], cpu: number, memoryKiB: number, name = "") => ({
  type,
  name,
  cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 0 },
  memory: { workingSetSize: memoryKiB, peakWorkingSetSize: memoryKiB * 2 },
})

it("totals all app processes without renormalizing CPU or using peak memory", () => {
  const usage = summarizeResourceUsage([
    metric("Browser", 1, 1024),
    metric("Tab", 2, 2048),
    metric("Tab", 3, 3072),
    metric("Utility", 4, 4096, "Glass backend"),
    metric("Utility", 5, 5120, "Network Service"),
    metric("GPU", 6, 6144),
  ])

  expect(usage).toEqual({
    cpuPercent: 21,
    memoryBytes: 21 * 1024 ** 2,
    processes: [
      { name: "Main", cpuPercent: 1, memoryBytes: 1024 ** 2 },
      { name: "Renderer", cpuPercent: 5, memoryBytes: 5 * 1024 ** 2 },
      { name: "Backend", cpuPercent: 4, memoryBytes: 4 * 1024 ** 2 },
      { name: "GPU / other", cpuPercent: 11, memoryBytes: 11 * 1024 ** 2 },
    ],
  })
})

it("reports missing memory as unavailable instead of showing an incomplete total", () => {
  const usage = summarizeResourceUsage([
    metric("Browser", 1, 1024),
    { type: "Tab", cpu: { percentCPUUsage: 2, idleWakeupsPerSecond: 0 } },
  ])

  expect(usage.cpuPercent).toBe(3)
  expect(usage.memoryBytes).toBeNull()
  expect(usage.processes.find(({ name }) => name === "Renderer")?.memoryBytes).toBeNull()
  expect(usage.processes.find(({ name }) => name === "Main")?.memoryBytes).toBe(1024 ** 2)
})
