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
import { connect, createServer, type Socket } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { isolatedGitEnv } from "../src/gitEnv.ts"
import type { AgentModels, Plugin } from "@glass/plugin"
import { hostPort, portOf } from "./ports.ts"
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

const ingress = (folder: string, upstreamPort: number) =>
  new Promise<number>((resolve, reject) => {
    const open = new Set<Socket>()

    const server = createServer((socket) => {
      if (dropping(folder)) {
        socket.destroy()

        return
      }

      const upstream = connect(upstreamPort, "127.0.0.1")
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
    // taskkill returns before a process lets go of its working directory, which blocks deleting it.
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", killAndAwaitExit(pid)],
      { windowsHide: true },
    )

    return
  }

  // Effect gives agent programs their own process groups, outside the host's group.
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

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"]

const piModel = { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] }

const sandboxModels: Record<"claude-code" | "pi", AgentModels> = {
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
      engines: ["claude-code", "pi"],
      create: async (request, { progress, record }) => {
        const settings = readSettings(settingsPath)

        progress("Creating the Sandbox")
        const folder = join(settings.root, request.agentId)
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

        progress("Starting the agent")
        const bundle = join(folder, "agentHost.mjs")
        copyFileSync(request.host.bundle, bundle)

        const hostEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...request.host.environment,
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
        const port = await hostPort(host)
        writeFileSync(
          join(folder, "host.json"),
          Schema.encodeSync(HostFile)({
            pid: host.pid,
            port,
            token: request.host.environment["GLASS_HOST_TOKEN"] ?? "",
          }),
        )
        record({ folder, ingressPort: await ingress(folder, port) })
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
        const hostPath = join(folder, "host.json")

        if (!existsSync(folder)) throw glass.sandboxGone()

        if (existsSync(hostPath))
          await killTree(Schema.decodeUnknownSync(HostFile)(readFileSync(hostPath, "utf8")).pid)

        rmSync(folder, { recursive: true, force: true })
      },
      models: async (engine) => {
        if (engine === "opencode") throw new Error("Fake Sandboxes do not run OpenCode")

        return sandboxModels[engine]
      },
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

  const sandboxFolder = (agentId: string) => join(settings.root, agentId)
  const hostFile = (agentId: string) => join(sandboxFolder(agentId), "host.json")

  const host = (agentId: string) =>
    Schema.decodeUnknownSync(HostFile)(readFileSync(hostFile(agentId), "utf8"))

  return {
    dropConnections: (agentId: string) => {
      const folder = sandboxFolder(agentId)
      writeFileSync(join(folder, "dropped"), "")

      return whenExists(droppedAll(folder))
    },
    reconnect: (agentId: string) => {
      rmSync(join(sandboxFolder(agentId), "dropped"))
      rmSync(droppedAll(sandboxFolder(agentId)), { force: true })
    },
    host,
    killHost: (agentId: string) => killTree(host(agentId).pid),
    stopHosts: async () => {
      for (const agentId of readdirSync(settings.root))
        if (existsSync(hostFile(agentId))) await killTree(host(agentId).pid)
    },
  }
}
