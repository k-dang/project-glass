import { Schema } from "effect"
import { spawnSync } from "node:child_process"

const CheckoutProcess = Schema.Struct({
  pid: Schema.Number,
  parentPid: Schema.Number,
  parentAlive: Schema.Boolean,
  command: Schema.String,
})

export type CheckoutProcess = typeof CheckoutProcess.Type

const WindowsProcesses = Schema.fromJsonString(Schema.Array(CheckoutProcess))

// WARNING: Windows reuses process ids, so a parent only counts as alive if it started before its child.
const LIST_WINDOWS_PROCESSES = String.raw`
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine)
$started = @{}
foreach ($p in $all) { $started[$p.ProcessId] = $p.CreationDate }
$root = $env:GLASS_CHECKOUT
ConvertTo-Json -Compress -InputObject @($all | Where-Object {
  $_.Name -in 'node.exe', 'electron.exe' -and $_.CommandLine -and
  $_.CommandLine.ToLower().Replace('/', '\').Contains($root)
} | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    parentAlive = [bool]($started.ContainsKey($_.ParentProcessId) -and $started[$_.ParentProcessId] -le $_.CreationDate)
    command = $_.CommandLine
  }
})
`

const listWindows = (root: string) =>
  Schema.decodeUnknownSync(WindowsProcesses)(
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", LIST_WINDOWS_PROCESSES], {
      encoding: "utf8",
      env: { ...process.env, GLASS_CHECKOUT: root.toLowerCase().replaceAll("/", "\\") },
    }).stdout,
  )

const listUnix = (root: string): ReadonlyArray<CheckoutProcess> => {
  const rows = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" })
    .stdout.split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)

      return match === null
        ? []
        : [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? "" }]
    })

  const pids = new Set(rows.map((row) => row.pid))

  return rows
    .filter((row) => row.command.includes(root) && /(^|\/)(node|electron)\b/i.test(row.command))
    .map((row) => ({ ...row, parentAlive: row.parentPid !== 1 && pids.has(row.parentPid) }))
}

export const checkoutProcesses = (root: string) =>
  (process.platform === "win32" ? listWindows(root) : listUnix(root)).filter(
    (listed) => listed.pid !== process.pid,
  )

export const orphans = (processes: ReadonlyArray<CheckoutProcess>, kept: ReadonlySet<number>) =>
  processes.filter((listed) => !listed.parentAlive && !kept.has(listed.pid))
