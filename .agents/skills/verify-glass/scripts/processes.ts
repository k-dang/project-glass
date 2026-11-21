import { Schema } from "effect"
import { spawnSync } from "node:child_process"

const CheckoutProcess = Schema.Struct({ pid: Schema.Number, command: Schema.String })

export type CheckoutProcess = typeof CheckoutProcess.Type

const WindowsProcesses = Schema.fromJsonString(Schema.Array(CheckoutProcess))

const LIST_WINDOWS_PROCESSES = String.raw`
ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in 'node.exe', 'electron.exe' -and $_.CommandLine -and
  $_.CommandLine.ToLower().Replace('/', '\').Contains($env:GLASS_CHECKOUT)
} | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; command = $_.CommandLine } })
`

const listWindows = (root: string) =>
  Schema.decodeUnknownSync(WindowsProcesses)(
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", LIST_WINDOWS_PROCESSES], {
      encoding: "utf8",
      env: { ...process.env, GLASS_CHECKOUT: root.toLowerCase().replaceAll("/", "\\") },
    }).stdout,
  )

export const parsePs = (output: string, root: string): ReadonlyArray<CheckoutProcess> =>
  output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    const command = match?.[2] ?? ""

    return command.includes(root) && /(^|\/)(node|electron)(\s|$)/i.test(command.split(" ")[0] ?? "")
      ? [{ pid: Number(match?.[1]), command }]
      : []
  })

const listUnix = (root: string) =>
  parsePs(spawnSync("ps", ["-ww", "-eo", "pid=,args="], { encoding: "utf8" }).stdout, root)

export const checkoutProcesses = (root: string) =>
  (process.platform === "win32" ? listWindows(root) : listUnix(root)).filter(
    (listed) => listed.pid !== process.pid,
  )
