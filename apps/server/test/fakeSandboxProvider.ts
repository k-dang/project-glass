import { Schema } from "effect"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { connect, createServer, type Socket } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isolatedGitEnv } from "../src/gitEnv.ts"
import type { Plugin } from "../src/SandboxProvider"
import { freePort, portOf } from "./ports.ts"

const FakeSandboxStep = Schema.Literals([
  "Creating the Sandbox",
  "Cloning the repository",
  "Starting the agent",
])

export type FakeSandboxStep = typeof FakeSandboxStep.Type

const FakeSandboxSettings = Schema.Struct({
  root: Schema.String,
  cloneFrom: Schema.String,
  piCommand: Schema.String,
  claudeCommand: Schema.String,
  missingLogin: Schema.optional(Schema.Struct({ login: Schema.String, fix: Schema.String })),
  noCapacity: Schema.optional(Schema.String),
  failAt: Schema.optional(FakeSandboxStep),
  holdAt: Schema.optional(FakeSandboxStep),
})

export type FakeSandboxSettings = typeof FakeSandboxSettings.Type

const readSettings = (path: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(FakeSandboxSettings))(readFileSync(path, "utf8"))

const FakeSandbox = Schema.Struct({
  folder: Schema.String,
  ingressPort: Schema.optional(Schema.Int),
  pid: Schema.optional(Schema.Int),
})

const decodeSandbox = Schema.decodeUnknownSync(FakeSandbox)

const dropping = (folder: string) => existsSync(join(folder, "dropped"))

const INGRESS_PATH = "/fake-ingress"

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

const holdWhile = (holding: () => boolean, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (signal.aborted) reject(new Error("Cancelled"))
      else if (!holding()) resolve()
      else return

      clearInterval(timer)
    }, 20)
  })

const stopHost = (pid: number | undefined) => {
  if (pid === undefined) return

  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

export const fakeSandboxProvider =
  (settingsPath: string): Plugin =>
  (glass) => {
    glass.registerSandboxProvider("fake", {
      name: "Fake Sandboxes",
      create: async (request, { progress, record, signal }) => {
        const settings = readSettings(settingsPath)

        if (settings.missingLogin !== undefined)
          throw glass.missingLogin(settings.missingLogin.login, settings.missingLogin.fix)

        if (settings.noCapacity !== undefined) throw glass.noCapacity(settings.noCapacity)

        const step = async (name: FakeSandboxStep) => {
          progress(name)

          await holdWhile(() => readSettings(settingsPath).holdAt === name, signal)

          if (settings.failAt === name) throw new Error(`The fake failed at ${name}`)
        }

        await step("Creating the Sandbox")
        const folder = join(settings.root, request.agentId)
        mkdirSync(folder, { recursive: true })
        record({ folder })

        await step("Cloning the repository")
        const clone = join(folder, request.folder)
        const env = isolatedGitEnv()
        execFileSync("git", ["clone", "--quiet", settings.cloneFrom, clone], { env })
        execFileSync(
          "git",
          ["checkout", "--quiet", "-b", request.branch, `origin/${request.baseBranch}`],
          { cwd: clone, env },
        )

        await step("Starting the agent")
        const freeHostPort = await freePort()

        const host = spawn(process.execPath, [request.host.bundle], {
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
        writeFileSync(join(folder, "host.pid"), String(host.pid))
        record({ folder, ingressPort: await ingress(folder, freeHostPort), pid: host.pid })
      },
      target: async (state) => ({
        url: `http://127.0.0.1:${decodeSandbox(state).ingressPort}${INGRESS_PATH}`,
        headers: { "x-fake-sandbox": "yes" },
      }),
      remove: async (state) => {
        const { missingLogin } = readSettings(settingsPath)

        if (missingLogin !== undefined)
          throw glass.missingLogin(missingLogin.login, missingLogin.fix)

        const { folder, pid } = decodeSandbox(state)
        stopHost(pid)
        rmSync(folder, { recursive: true, force: true })
      },
      models: async () => ({
        defaultModel: { id: "fake/sandbox-model", name: "Sandbox model", efforts: [] },
        models: [{ id: "fake/sandbox-model", name: "Sandbox model", efforts: [] }],
      }),
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
  const pidFile = (agentId: string) => join(sandboxFolder(agentId), "host.pid")

  return {
    configure: (change: Partial<FakeSandboxSettings>) =>
      writeFileSync(settingsPath, JSON.stringify({ ...settings, ...change })),
    sandboxFolder,
    dropConnections: (agentId: string) =>
      writeFileSync(join(sandboxFolder(agentId), "dropped"), ""),
    reconnect: (agentId: string) => rmSync(join(sandboxFolder(agentId), "dropped")),
    hostPid: (agentId: string) => Number(readFileSync(pidFile(agentId), "utf8")),
    stopHosts: () => {
      for (const agentId of readdirSync(settings.root))
        if (existsSync(pidFile(agentId))) stopHost(Number(readFileSync(pidFile(agentId), "utf8")))
    },
  }
}
