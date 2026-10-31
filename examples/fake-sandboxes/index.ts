import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Plugin, SandboxState } from "@glass/plugin"

const run = promisify(execFile)

const SANDBOXES = join(tmpdir(), "glass-fake-sandboxes")

const FAKE_CLAUDE = join(import.meta.dirname, "claude.mjs")

const FAKE_MODEL = { id: "fake-model", name: "Fake model", efforts: [] }

const decodeSandbox = (state: SandboxState) => {
  if (typeof state === "object" && state !== null && "folder" in state && "port" in state) {
    const { folder, port } = state

    if (typeof folder === "string" && typeof port === "number") return { folder, port }
  }

  throw new Error("This isn't a fake Sandbox's state")
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()

      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("The port finder didn't get a port")),
      )
    })
  })

const plugin: Plugin = (glass) => {
  glass.registerSandboxProvider("fake", {
    name: "Fake Sandboxes",
    engines: ["claude-code"],
    create: async (request, { progress, record, signal }) => {
      progress("Creating the Sandbox")
      const folder = join(SANDBOXES, request.agentId)
      await mkdir(folder, { recursive: true })
      const port = await freePort()
      record({ folder, port })

      progress("Cloning the repository")
      const clone = join(folder, request.folder)
      const { owner, repo } = request.repository
      const url = `https://github.com/${owner}/${repo}.git`
      await run(
        "git",
        ["clone", "--quiet", "--single-branch", "--branch", request.baseBranch, url, clone],
        { signal },
      )
      await run(
        "git",
        ["checkout", "--quiet", "-b", request.branch, `origin/${request.baseBranch}`],
        { cwd: clone, signal },
      )

      progress("Starting the agent")

      const host = spawn(process.execPath, [request.host.bundle], {
        cwd: folder,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          ...request.host.environment,
          ELECTRON_RUN_AS_NODE: "1",
          GLASS_HOST_PORT: String(port),
          GLASS_HOST_ADDRESS: "127.0.0.1",
          GLASS_CLAUDE_COMMAND: FAKE_CLAUDE,
        },
      })

      await once(host, "spawn")
      host.unref()
    },
    target: async (state) => ({
      url: `http://127.0.0.1:${decodeSandbox(state).port}`,
      headers: {},
    }),
    remove: async (state) => {
      await rm(decodeSandbox(state).folder, { recursive: true, force: true, maxRetries: 10 })
    },
    models: async () => ({ defaultModel: FAKE_MODEL, models: [FAKE_MODEL] }),
  })
}

export default plugin
