import { AgentHarness } from "@glass/contracts"
import { Schema } from "effect"
import { execFile, execFileSync, spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { rm } from "node:fs/promises"
import { connect, createServer, type Socket } from "node:net"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { isolatedGitEnv } from "../src/gitEnv.ts"
import type { AgentModels, Plugin } from "@glass/plugin"
import { hostPort } from "../src/agentHost/protocol.ts"
import { portOf } from "./ports.ts"
import { whenExists } from "./whenExists.ts"

const FakeSandboxSettings = Schema.Struct({
  root: Schema.String,
  cloneFrom: Schema.String,
  piCommand: Schema.String,
  claudeCommand: Schema.String,
  home: Schema.optional(Schema.String),
})

export type FakeSandboxSettings = typeof FakeSandboxSettings.Type

const readSettings = (path: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(FakeSandboxSettings))(readFileSync(path, "utf8"))

const FakeSandbox = Schema.Struct({
  folder: Schema.String,
  ingressPort: Schema.optional(Schema.Int),
})

const decodeSandbox = Schema.decodeUnknownSync(FakeSandbox)

const dropping = (folder: string) => existsSync(join(folder, "dropped"))

const droppedAll = (folder: string) => join(folder, "dropped-all")

const INGRESS_PATH = "/fake-ingress"

const HostFile = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int, port: Schema.Int, token: Schema.String }),
)

const hostFileIn = (folder: string) => join(folder, "host.json")

const hostIn = (folder: string) => {
  const path = hostFileIn(folder)

  return existsSync(path)
    ? Schema.decodeUnknownSync(HostFile)(readFileSync(path, "utf8"))
    : undefined
}

const requestLine = /^([A-Z]+) (\S+) HTTP\/1\.1\r$/gm

const notFound = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

const fromIngressPath = (text: string) => {
  let outside = false

  const rewritten = text.replace(requestLine, (_line, method: string, path: string) => {
    if (!path.startsWith(`${INGRESS_PATH}/`)) outside = true

    return `${method} ${path.slice(INGRESS_PATH.length)} HTTP/1.1\r`
  })

  return outside ? null : rewritten
}

const ingress = (folder: string) =>
  new Promise<number>((resolve, reject) => {
    const open = new Set<Socket>()

    const server = createServer((socket) => {
      const host = hostIn(folder)

      if (dropping(folder) || host === undefined) {
        socket.destroy()

        return
      }

      const upstream = connect(host.port, "127.0.0.1")
      let upgraded = false
      let pending = ""

      const close = () => {
        socket.destroy()
        upstream.destroy()
        open.delete(socket)
      }

      open.add(socket)

      socket.on("data", (chunk) => {
        if (upgraded) {
          upstream.write(chunk)

          return
        }

        pending += chunk.toString("latin1")
        const headersEnd = pending.lastIndexOf("\r\n\r\n") + 4

        if (headersEnd < 4) return

        const headers = pending.slice(0, headersEnd)
        const rest = pending.slice(headersEnd)
        pending = ""
        const rewritten = fromIngressPath(headers)

        if (rewritten === null) {
          socket.end(notFound)
        } else {
          upgraded = /^upgrade: websocket\r$/im.test(headers)
          upstream.write(Buffer.from(rewritten + rest, "latin1"))
        }
      })

      upstream.pipe(socket)
      socket.on("close", close).on("error", close)
      upstream.on("close", close).on("error", close)
    })

    const watching = setInterval(() => {
      const deleted = !existsSync(folder)

      if (deleted || dropping(folder)) for (const socket of open) socket.destroy()

      if (!deleted && dropping(folder) && !existsSync(droppedAll(folder)))
        writeFileSync(droppedAll(folder), "")

      if (deleted) {
        clearInterval(watching)
        server.close()
      }
    }, 20)

    watching.unref()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(portOf(server)))
  })

const execFileAsync = promisify(execFile)

const killAndAwaitExit = (pid: number) =>
  [
    `$target = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if (-not $target) { exit 0 }",
    "$null = $target.Handle",
    `taskkill /PID ${pid} /T /F | Out-Null`,
    "if ($LASTEXITCODE -ne 0 -and -not $target.HasExited) { exit 1 }",
    "$target.WaitForExit()",
  ].join("; ")

const killTree = async (pid: number) => {
  if (process.platform === "win32") {
    // WARNING: taskkill returns before a process lets go of its working directory, which blocks deleting it.
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", killAndAwaitExit(pid)],
      { windowsHide: true },
    )

    return
  }

  // WARNING: Effect gives Agent harness processes their own process groups, outside the host's group.
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="])

  const processes = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [child, parent] = line.trim().split(/\s+/)

      return { pid: Number(child), parent: Number(parent) }
    })

  const pids = [pid]

  for (const parent of pids)
    pids.push(...processes.filter((child) => child.parent === parent).map((child) => child.pid))

  await execFileAsync("kill", ["-KILL", ...pids.toReversed().map(String)]).catch(() => {})
}

// WARNING: Electron's rmSync can't delete read-only files, such as git's objects, on Windows; rm can.
const removeFolder = async (folder: string) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rm(folder, { recursive: true, force: true })
    } catch (error) {
      if (attempt === 5) throw error
      // oxlint-disable-next-line glass/test-waits -- A Sandbox provider backing off, not a test waiting on work.
      await sleep(100 * attempt)
    }
  }
}

const endHost = async (folder: string) => {
  const host = hostIn(folder)

  if (host !== undefined) await killTree(host.pid)
}

const removeSandbox = async (folder: string) => {
  await endHost(folder)
  await removeFolder(folder)
}

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"]

const piModel = { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] }

const sandboxModels: Record<AgentHarness, AgentModels> = {
  "claude-code": {
    defaultModel: { id: "default", name: "Opus", efforts: claudeEfforts },
    models: [
      { id: "opus", name: "Opus", efforts: claudeEfforts },
      { id: "fable", name: "Fable", efforts: claudeEfforts },
      { id: "sonnet", name: "Sonnet", efforts: claudeEfforts },
      { id: "haiku", name: "Haiku", efforts: claudeEfforts },
    ],
  },
  pi: {
    defaultModel: piModel,
    models: [
      piModel,
      {
        id: "glass-test/gpt-test-thinking",
        name: "GPT Test Thinking",
        efforts: ["off", "minimal", "low", "medium", "high"],
      },
    ],
  },
}

export const fakeSandboxProvider =
  (settingsPath: string): Plugin =>
  (glass) => {
    glass.registerSandboxProvider("fake", {
      name: "Fake Sandboxes",
      harnesses: ["claude-code", "pi"],
      create: async (request, { progress, record }) => {
        const settings = readSettings(settingsPath)

        progress("Creating the Sandbox")
        const folder = join(settings.root, request.threadId)
        mkdirSync(folder, { recursive: true })
        record({ folder })

        progress("Cloning the repository")
        const clone = join(folder, request.folder)
        const env = isolatedGitEnv()
        execFileSync("git", ["clone", "--quiet", settings.cloneFrom, clone], { env })
        execFileSync(
          "git",
          ["checkout", "--quiet", "-b", request.branch, `origin/${request.baseBranch}`],
          { cwd: clone, env },
        )
        record({ folder, ingressPort: await ingress(folder) })
      },
      startHost: async (state, { bundle: source, environment }) => {
        const settings = readSettings(settingsPath)
        const { folder } = decodeSandbox(state)

        if (!existsSync(folder)) throw glass.sandboxGone()

        await endHost(folder)
        const bundle = join(folder, "agentHost.mjs")
        copyFileSync(source, bundle)

        const hostEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...environment,
          ELECTRON_RUN_AS_NODE: "1",
          GLASS_HOST_PORT: "0",
          GLASS_HOST_ADDRESS: "127.0.0.1",
          GLASS_PI_COMMAND: settings.piCommand,
          GLASS_CLAUDE_COMMAND: settings.claudeCommand,
        }

        if (settings.home !== undefined) {
          hostEnv["HOME"] = settings.home
          hostEnv["USERPROFILE"] = settings.home
        }

        const host = spawn(process.execPath, [bundle], {
          cwd: folder,
          env: hostEnv,
          stdio: ["ignore", "inherit", "inherit", "pipe"],
          detached: process.platform !== "win32",
        })

        if (host.pid === undefined) throw new Error("The agent host didn't start")
        writeFileSync(
          hostFileIn(folder),
          Schema.encodeSync(HostFile)({
            pid: host.pid,
            port: await hostPort(host),
            token: environment["GLASS_HOST_TOKEN"] ?? "",
          }),
        )
      },
      target: async (state) => {
        const { folder, ingressPort } = decodeSandbox(state)

        if (!existsSync(folder)) throw glass.sandboxGone()

        return {
          url: `http://127.0.0.1:${ingressPort}${INGRESS_PATH}`,
          headers: { "x-fake-sandbox": "yes" },
        }
      },
      remove: async (state) => {
        const { folder } = decodeSandbox(state)

        if (!existsSync(folder)) throw glass.sandboxGone()

        await removeSandbox(folder)
      },
      models: async (harness) => sandboxModels[harness],
    })
  }

export const installFakeSandboxProvider = (
  home: string,
  settings: FakeSandboxSettings,
  providerSourcePath = fileURLToPath(import.meta.url),
) => {
  const plugins = join(home, ".project-glass", "plugins")
  const settingsPath = join(home, "fake-sandboxes.json")
  mkdirSync(plugins, { recursive: true })
  mkdirSync(settings.root, { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings))
  writeFileSync(
    join(plugins, "fake-sandboxes.ts"),
    `import { fakeSandboxProvider } from ${JSON.stringify(providerSourcePath)}\n` +
      `export default fakeSandboxProvider(${JSON.stringify(settingsPath)})\n`,
  )

  const sandboxFolder = (threadId: string) => join(settings.root, threadId)

  const host = (threadId: string) => {
    const found = hostIn(sandboxFolder(threadId))

    if (found === undefined) throw new Error(`No agent host runs in the Sandbox of ${threadId}`)

    return found
  }

  return {
    dropConnections: (threadId: string) => {
      const folder = sandboxFolder(threadId)
      writeFileSync(join(folder, "dropped"), "")

      return whenExists(droppedAll(folder))
    },
    reconnect: (threadId: string) => {
      rmSync(join(sandboxFolder(threadId), "dropped"))
      rmSync(droppedAll(sandboxFolder(threadId)), { force: true })
    },
    host,
    killHost: (threadId: string) => killTree(host(threadId).pid),
    remove: (threadId: string) => removeSandbox(sandboxFolder(threadId)),
    stopHosts: async () => {
      for (const threadId of readdirSync(settings.root)) await endHost(sandboxFolder(threadId))
    },
  }
}
