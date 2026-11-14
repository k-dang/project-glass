import { execFileSync } from "node:child_process"

const processes = (): ReadonlyArray<{ pid: number; ppid: number; command: string }> =>
  process.platform === "win32"
    ? JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; command = [string]$_.CommandLine } } | ConvertTo-Json -Compress",
          ],
          { encoding: "utf8" },
        ),
      )
    : execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .map(([pid, ppid, ...words]) => ({
          pid: Number(pid),
          ppid: Number(ppid),
          command: words.join(" "),
        }))

export const childProcesses = (parent: number, command: string) =>
  processes()
    .filter((child) => child.ppid === parent && child.command.includes(command))
    .map((child) => child.pid)

export const startedHost = (before: ReadonlyArray<number>) =>
  childProcesses(process.pid, "scriptedAgentHost.mjs").find((pid) => !before.includes(pid))
