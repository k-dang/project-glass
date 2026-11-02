import { AgentEngine } from "@glass/contracts"
import { Schema } from "effect"
import { execFileSync, spawn } from "node:child_process"
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
import { isolatedGitEnv } from "../src/gitEnv.ts"
import type { AgentModels, Plugin } from "@glass/plugin"
import { freePort, portOf } from "./ports.ts"

const FakeSandboxSettings = Schema.Struct({
  root: Schema.String,
  cloneFrom: Schema.String,
  piCommand: Schema.String,
  claudeCommand: Schema.String,
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

const ingress = (folder: string, hostPort: number) =>
  new Promise<number>((resolve, reject) => {
    const open = new Set<Socket>()

    const server = createServer((socket) => {
      if (dropping(folder)) {
        socket.destroy()

        return
      }

      const upstream = connect(hostPort, "127.0.0.1")
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

/** Ends a host and the programs it started, which Windows leaves running when only the host ends. */
const killTree = (pid: number) => {
  try {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" })
    else process.kill(pid, "SIGKILL")
  } catch {}
}

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"]

const piModel = { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] }

/** What the pinned Claude Code and the fake model provider's pi offer once a Sandbox runs them. */
const sandboxModels: Record<AgentEngine, AgentModels> = {
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
        const freeHostPort = await freePort()
        // Copied alone, as a real provider uploads it, so a bundle that needs its neighbours fails here.
        const bundle = join(folder, "agentHost.mjs")
        copyFileSync(request.host.bundle, bundle)

        const host = spawn(process.execPath, [bundle], {
          cwd: folder,
          env: {
            ...process.env,
            ...request.host.environment,
            ELECTRON_RUN_AS_NODE: "1",
            GLASS_HOST_PORT: String(freeHostPort),
            GLASS_HOST_ADDRESS: "127.0.0.1",
            GLASS_PI_COMMAND: settings.piCommand,
            GLASS_CLAUDE_COMMAND: settings.claudeCommand,
          },
          stdio: ["ignore", "inherit", "inherit"],
        })

        if (host.pid === undefined) throw new Error("The agent host didn't start")
        writeFileSync(
          join(folder, "host.json"),
          Schema.encodeSync(HostFile)({
            pid: host.pid,
            port: freeHostPort,
            token: request.host.environment["GLASS_HOST_TOKEN"] ?? "",
          }),
        )
        record({ folder, ingressPort: await ingress(folder, freeHostPort) })
      },
      target: async (state) => ({
        url: `http://127.0.0.1:${decodeSandbox(state).ingressPort}${INGRESS_PATH}`,
        headers: { "x-fake-sandbox": "yes" },
      }),
      remove: async (state) => {
        const { folder } = decodeSandbox(state)
        const hostPath = join(folder, "host.json")

        if (existsSync(hostPath))
          killTree(Schema.decodeUnknownSync(HostFile)(readFileSync(hostPath, "utf8")).pid)

        rmSync(folder, { recursive: true, force: true, maxRetries: 10 })
      },
      models: async (engine) => sandboxModels[engine],
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

  /** The Sandbox's agent host, reachable without its ingress. */
  const host = (agentId: string) =>
    Schema.decodeUnknownSync(HostFile)(readFileSync(hostFile(agentId), "utf8"))

  return {
    dropConnections: (agentId: string) =>
      writeFileSync(join(sandboxFolder(agentId), "dropped"), ""),
    reconnect: (agentId: string) => rmSync(join(sandboxFolder(agentId), "dropped")),
    host,
    /** Ends a Sandbox's host and its programs, as a crash would. */
    killHost: (agentId: string) => killTree(host(agentId).pid),
    stopHosts: () => {
      for (const agentId of readdirSync(settings.root))
        if (existsSync(hostFile(agentId))) killTree(host(agentId).pid)
    },
  }
}
