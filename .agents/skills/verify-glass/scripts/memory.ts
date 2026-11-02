import { Schema } from "effect"
import { spawnSync } from "node:child_process"
import type { Cdp } from "./cdp.ts"

/**
 * Memory sampling for an agent feedback loop.
 *
 * Two sources that don't overlap: CDP reports what the renderer holds (V8 heap, Blink counters, worker
 * heaps), and the OS process tree reports what the processes cost. CDP alone can't see RSS, the GPU
 * process, or the backend; the process tree alone can't tell a diff cache from a React tree.
 */

const HeapUsage = Schema.Struct({
  usedSize: Schema.Number,
  totalSize: Schema.Number,
  embedderHeapUsedSize: Schema.Number,
  backingStorageSize: Schema.Number,
})

type HeapUsage = typeof HeapUsage.Type

const Metric = Schema.Struct({ name: Schema.String, value: Schema.Number })

const Metrics = Schema.Struct({ metrics: Schema.Array(Metric) })

const DomCounters = Schema.Struct({
  documents: Schema.Number,
  nodes: Schema.Number,
  jsEventListeners: Schema.Number,
})

const AttachedToTarget = Schema.Struct({
  sessionId: Schema.String,
  targetInfo: Schema.Struct({
    targetId: Schema.String,
    type: Schema.String,
    url: Schema.String,
  }),
})

const DetachedFromTarget = Schema.Struct({ sessionId: Schema.String })

const Empty = Schema.Struct({})

/** Counters that only grow, so a sample reports the change since the one before it. */
const CUMULATIVE = new Set([
  "LayoutCount",
  "RecalcStyleCount",
  "LayoutDuration",
  "RecalcStyleDuration",
  "ScriptDuration",
  "TaskDuration",
  "DevToolsCommandDuration",
  "V8CompileDuration",
])

export type ProcessRole = "main" | "renderer" | "gpu" | "backend" | "utility" | "child" | "other"

export interface ProcessRow {
  readonly pid: number
  readonly role: ProcessRole
  /** Working set, the number the app's own RAM readout sums. Shared pages count in every process. */
  readonly rss: number
  /** Commit charge: the process's own pages. Steadier than the working set, which the OS trims. */
  readonly private: number
}

export interface WorkerSample {
  readonly type: string
  readonly url: string
  readonly heap: HeapUsage
}

export interface MemorySample {
  readonly at: string
  readonly seq: number
  /** Which area the sweep was showing when this sample was taken. */
  readonly label?: string
  readonly renderer: {
    readonly heap: HeapUsage
    readonly metrics: Readonly<Record<string, number>>
    readonly sincePrevious: Readonly<Record<string, number>>
    readonly dom: typeof DomCounters.Type
  }
  readonly workers: ReadonlyArray<WorkerSample>
  readonly processes: ReadonlyArray<ProcessRow>
  readonly totals: Readonly<Record<ProcessRole, number>>
}

interface RawProcess {
  readonly pid: number
  readonly ppid: number
  readonly rss: number
  readonly private: number
  readonly command: string
}

const isWindows = process.platform === "win32"

const readWindowsProcesses = (): ReadonlyArray<RawProcess> => {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PageFileUsage,CommandLine | ConvertTo-Json -Compress"
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0 || !result.stdout) return []
  const parsed: unknown = JSON.parse(result.stdout)
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const CimProcess = Schema.Struct({
    ProcessId: Schema.Number,
    ParentProcessId: Schema.Number,
    WorkingSetSize: Schema.NullOr(Schema.Number),
    PageFileUsage: Schema.NullOr(Schema.Number),
    CommandLine: Schema.NullOr(Schema.String),
  })
  const decode = Schema.decodeUnknownSync(CimProcess)
  return entries.flatMap((entry: unknown) => {
    try {
      const process = decode(entry)
      return [
        {
          pid: process.ProcessId,
          ppid: process.ParentProcessId,
          rss: process.WorkingSetSize ?? 0,
          // `PageFileUsage` is kilobytes where `WorkingSetSize` is bytes.
          private: (process.PageFileUsage ?? 0) * 1024,
          command: process.CommandLine ?? "",
        },
      ]
    } catch {
      return []
    }
  })
}

const readPosixProcesses = (): ReadonlyArray<RawProcess> => {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) return []
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null
      ? []
      : [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rss: Number(match[3]) * 1024,
            // `ps` reports no commit charge; RSS is the only per-process figure it has.
            private: Number(match[3]) * 1024,
            command: match[4]!,
          },
        ]
  })
}

const readProcesses = () => (isWindows ? readWindowsProcesses() : readPosixProcesses())

const roleOf = (process: RawProcess, parentRole: ProcessRole): ProcessRole => {
  const type = /--type=([a-z-]+)/.exec(process.command)?.[1]
  switch (type) {
    case "renderer":
      return "renderer"
    case "gpu-process":
      return "gpu"
    case "utility":
      return /node\.mojom\.NodeService/.test(process.command) ? "backend" : "utility"
    case undefined:
      // Agent CLIs the backend spawns carry no `--type`, and they are worth their own row.
      return parentRole === "main" ? "other" : "child"
    default:
      return "other"
  }
}

/** Every process below the app's main process, with the role its command line and parent imply. */
export const processTree = (rootPid: number | undefined): ReadonlyArray<ProcessRow> => {
  if (rootPid === undefined) return []
  const processes = readProcesses()
  const byPid = new Map(processes.map((process) => [process.pid, process]))
  const children = new Map<number, Array<RawProcess>>()
  for (const process of processes) {
    const siblings = children.get(process.ppid) ?? []
    siblings.push(process)
    children.set(process.ppid, siblings)
  }
  if (!byPid.has(rootPid)) return []

  const rows: Array<ProcessRow> = []
  const seen = new Set<number>()
  const queue: Array<{ pid: number; role: ProcessRole }> = [{ pid: rootPid, role: "main" }]
  while (queue.length > 0) {
    const next = queue.shift()!
    if (seen.has(next.pid)) continue
    seen.add(next.pid)
    const process = byPid.get(next.pid)
    if (process === undefined) continue
    rows.push({ pid: next.pid, role: next.role, rss: process.rss, private: process.private })
    for (const child of children.get(next.pid) ?? []) {
      queue.push({ pid: child.pid, role: roleOf(child, next.role) })
    }
  }
  return rows
}

export const totalsOf = (processes: ReadonlyArray<ProcessRow>) => {
  const totals: Record<ProcessRole, number> = {
    main: 0,
    renderer: 0,
    gpu: 0,
    backend: 0,
    utility: 0,
    child: 0,
    other: 0,
  }
  for (const process of processes) totals[process.role] += process.rss
  return totals
}

export interface Sampler {
  readonly sample: (seq: number, label?: string) => Promise<MemorySample>
  readonly close: () => void
}

/**
 * Starts collecting from a page target. Worker heaps live in their own V8 isolate and are absent from
 * the page's numbers, so auto-attach is what makes the Shiki workers visible at all.
 */
export const startSampler = async (page: Cdp, rootPid: number | undefined): Promise<Sampler> => {
  const sessions = new Map<string, { type: string; url: string }>()
  const decodeAttached = Schema.decodeUnknownSync(AttachedToTarget)
  const decodeDetached = Schema.decodeUnknownSync(DetachedFromTarget)

  const stopAttach = page.on("Target.attachedToTarget", (params) => {
    try {
      const { sessionId, targetInfo } = decodeAttached(params)
      sessions.set(sessionId, { type: targetInfo.type, url: targetInfo.url })
    } catch {
      // A target shape we don't understand is not worth failing a sample over.
    }
  })
  const stopDetach = page.on("Target.detachedFromTarget", (params) => {
    try {
      sessions.delete(decodeDetached(params).sessionId)
    } catch {
      // Same.
    }
  })

  await page.send("Performance.enable", Empty)
  await page.send("Target.setAutoAttach", Empty, {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })

  let previous: Record<string, number> = {}

  const sample = async (seq: number, label?: string): Promise<MemorySample> => {
    const [heap, metrics, dom] = await Promise.all([
      page.send("Runtime.getHeapUsage", HeapUsage),
      page.send("Performance.getMetrics", Metrics),
      page.send("Memory.getDOMCounters", DomCounters).catch(() => undefined),
    ])

    const values: Record<string, number> = {}
    for (const metric of metrics.metrics) values[metric.name] = metric.value

    const sincePrevious: Record<string, number> = {}
    for (const [name, value] of Object.entries(values)) {
      if (!CUMULATIVE.has(name)) continue
      const before = previous[name]
      if (before !== undefined) sincePrevious[name] = Math.max(0, value - before)
    }
    previous = values

    const workers = (
      await Promise.all(
        [...sessions].map(async ([sessionId, target]) => {
          try {
            return { ...target, heap: await page.send("Runtime.getHeapUsage", HeapUsage, {}, sessionId) }
          } catch {
            return undefined
          }
        }),
      )
    ).filter((worker) => worker !== undefined)

    const processes = processTree(rootPid)

    return {
      at: new Date().toISOString(),
      seq,
      ...(label === undefined ? {} : { label }),
      renderer: {
        heap,
        metrics: values,
        sincePrevious,
        dom: dom ?? {
          documents: values["Documents"] ?? 0,
          nodes: values["Nodes"] ?? 0,
          jsEventListeners: values["JSEventListeners"] ?? 0,
        },
      },
      workers,
      processes,
      totals: totalsOf(processes),
    }
  }

  return {
    sample,
    close: () => {
      stopAttach()
      stopDetach()
    },
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const pad = (text: string, width: number) => text.padStart(width)

/**
 * The block an agent reads first: what each bucket costs at the start, at the end, and at its worst.
 */
export const formatSummary = (
  samples: ReadonlyArray<MemorySample>,
  file: string,
  elapsed: number,
) => {
  if (samples.length === 0) return "no samples"
  const first = samples[0]!
  const last = samples.at(-1)!

  const series: Array<{ label: string; values: Array<number>; format: (value: number) => string }> = [
    { label: "renderer heap used", values: samples.map((s) => s.renderer.heap.usedSize), format: mb },
    {
      label: "renderer heap total",
      values: samples.map((s) => s.renderer.heap.totalSize),
      format: mb,
    },
    {
      label: "renderer backing storage",
      values: samples.map((s) => s.renderer.heap.backingStorageSize),
      format: mb,
    },
    { label: "DOM nodes", values: samples.map((s) => s.renderer.dom.nodes), format: String },
    {
      label: "event listeners",
      values: samples.map((s) => s.renderer.dom.jsEventListeners),
      format: String,
    },
    {
      label: `worker heaps (${last.workers.length})`,
      values: samples.map((s) => s.workers.reduce((sum, worker) => sum + worker.heap.usedSize, 0)),
      format: mb,
    },
    { label: "main RSS", values: samples.map((s) => s.totals.main), format: mb },
    { label: "renderer RSS", values: samples.map((s) => s.totals.renderer), format: mb },
    { label: "backend RSS", values: samples.map((s) => s.totals.backend), format: mb },
    { label: "GPU RSS", values: samples.map((s) => s.totals.gpu), format: mb },
    { label: "agent children RSS", values: samples.map((s) => s.totals.child), format: mb },
    {
      label: "total RSS",
      values: samples.map((s) => Object.values(s.totals).reduce((sum, value) => sum + value, 0)),
      format: mb,
    },
    {
      label: "total private",
      values: samples.map((s) => s.processes.reduce((sum, process) => sum + process.private, 0)),
      format: mb,
    },
  ]

  const rows = series.map(({ label, values, format }) => {
    const start = values[0] ?? 0
    const end = values.at(-1) ?? 0
    const peak = Math.max(...values)
    const delta = end - start
    return [
      label,
      format(start),
      format(end),
      `${delta >= 0 ? "+" : ""}${format(delta)}`,
      format(peak),
    ]
  })

  const header = ["", "first", "last", "delta", "peak"]
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  )
  const line = (cells: ReadonlyArray<string>) =>
    cells.map((cell, column) => pad(cell, widths[column]!)).join("  ")

  const layout = samples.map((s) => s.renderer.sincePrevious)
  const layoutTotals = {
    layouts: layout.reduce((sum, delta) => sum + (delta["LayoutCount"] ?? 0), 0),
    styleRecalcs: layout.reduce((sum, delta) => sum + (delta["RecalcStyleCount"] ?? 0), 0),
    scriptMs: Math.round(
      layout.reduce((sum, delta) => sum + (delta["ScriptDuration"] ?? 0), 0) * 1000,
    ),
  }

  return [
    `memory: ${samples.length} samples over ${(elapsed / 1000).toFixed(1)}s → ${file}`,
    "",
    line(header),
    ...rows.map(line),
    "",
    `work: ${layoutTotals.layouts} layouts, ${layoutTotals.styleRecalcs} style recalcs, ${layoutTotals.scriptMs}ms of script`,
    `window: ${first.at} → ${last.at}`,
  ].join("\n")
}

/** One row per visited area, from the last sample taken while it was showing. */
export const formatAreas = (
  samples: ReadonlyArray<MemorySample>,
  file: string,
  elapsed: number,
) => {
  const lastByLabel = new Map<string, MemorySample>()
  for (const sample of samples) {
    if (sample.label !== undefined) lastByLabel.set(sample.label, sample)
  }
  if (lastByLabel.size === 0) return "no areas sampled"

  const rows = [...lastByLabel].map(([label, sample]) => {
    const renderer = sample.processes.find((process) => process.role === "renderer")
    return [
      label,
      mb(sample.renderer.heap.usedSize),
      mb(sample.workers.reduce((sum, worker) => sum + worker.heap.usedSize, 0)),
      String(sample.renderer.dom.nodes),
      mb(renderer?.private ?? 0),
      mb(sample.processes.reduce((sum, process) => sum + process.private, 0)),
    ]
  })

  const header = ["area", "heap", "workers", "nodes", "renderer", "total private"]
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  )
  const line = (cells: ReadonlyArray<string>) =>
    cells.map((cell, column) => pad(cell, widths[column]!)).join("  ")

  return [
    `areas: ${rows.length} over ${(elapsed / 1000).toFixed(1)}s → ${file}`,
    "",
    line(header),
    ...rows.map(line),
  ].join("\n")
}
