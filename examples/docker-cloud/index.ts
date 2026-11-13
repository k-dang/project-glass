import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { setTimeout } from "node:timers/promises"
import { promisify } from "node:util"
import type { Glass, Plugin, SandboxProvider, SandboxState } from "./glass-plugin"

const exec = promisify(execFile)

const defaultModel = { id: "opencode/big-pickle", name: "Big Pickle", efforts: [] }

const root = "/home/agent/.glass"

const node = `${root}/runtime/node_modules/node/bin/node`

const windowsCommand = join(process.env["LOCALAPPDATA"] ?? "", "DockerSandboxes", "bin", "sbx.exe")

const command = process.platform === "win32" && existsSync(windowsCommand) ? windowsCommand : "sbx"

export type DockerCommand = (args: ReadonlyArray<string>, signal?: AbortSignal) => Promise<string>

const run: DockerCommand = async (args, signal) => {
  const options = { windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, signal }

  return (await exec(command, ["--cloud", ...args], options)).stdout
}

const stateOf = (state: SandboxState) => {
  if (
    typeof state === "object" &&
    state !== null &&
    "name" in state &&
    "port" in state &&
    typeof state.name === "string" &&
    /^glass-[a-f0-9-]+$/.test(state.name) &&
    typeof state.port === "number" &&
    Number.isInteger(state.port) &&
    state.port > 0 &&
    state.port <= 65535
  )
    return { name: state.name, port: state.port }
  throw new Error("Invalid Docker Cloud Sandbox state")
}

const isGone = (error: Error, name: string) => error.message.includes(`sandbox '${name}' not found`)

const parseInspection = (text: string) => {
  const value: unknown = JSON.parse(text)

  if (
    typeof value !== "object" ||
    value === null ||
    !("state" in value) ||
    !("expires_at" in value) ||
    !("ports" in value) ||
    typeof value.state !== "string" ||
    typeof value.expires_at !== "string" ||
    !Array.isArray(value.ports)
  )
    throw new Error("Docker returned an invalid Sandbox inspection")

  return { state: value.state, expires_at: value.expires_at, ports: value.ports }
}

export const dockerProvider = (glass: Glass, sbx: DockerCommand = run): SandboxProvider => {
  const inspect = async (name: string) => {
    try {
      return parseInspection(await sbx(["inspect", name, "--json"]))
    } catch (error) {
      if (error instanceof Error && isGone(error, name)) throw glass.sandboxGone()
      throw error
    }
  }

  return {
    name: "Docker Cloud Sandboxes",
    engines: ["opencode"],
    models: async () => ({ defaultModel, models: [defaultModel] }),
    create: async (request, { progress, record, signal }) => {
      if (request.engine !== "opencode") throw new Error("Docker Cloud Sandboxes supports OpenCode")
      const folder = posix.normalize(request.folder.replaceAll("\\", "/"))

      if (posix.isAbsolute(folder) || folder === ".." || folder.startsWith("../") || folder === ".")
        throw new Error("Glass supplied an invalid repository folder")
      signal.throwIfAborted()
      const name = `glass-${randomUUID()}`
      record({ name, port: request.host.port })
      progress("Creating an OpenCode Sandbox")

      // Keep creation alive after cancellation: delete can then await its exact resource, even
      // when the Cloud API accepted the request before the CLI returned its ID.
      const creating = sbx([
        "create",
        "--name",
        name,
        "--no-progress",
        "--cpus",
        "1",
        "--memory",
        "2g",
        "--ttl",
        "24h",
        "--on-timeout",
        "delete",
        "--platform",
        "linux/amd64",
        ...[
          "github.com",
          "api.github.com",
          "opencode.ai",
          "models.dev",
          "registry.npmjs.org",
        ].flatMap((host) => ["--allow-network", `${host}:443`]),
        "opencode",
      ])

      pendingCreates.set(name, creating)

      try {
        await creating
        signal.throwIfAborted()
        const temporary = await mkdtemp(join(tmpdir(), "glass-docker-"))

        try {
          progress("Preparing Node 24")
          await sbx(["exec", name, "mkdir", "-p", root], signal)
          await sbx(
            [
              "exec",
              name,
              "npm",
              "install",
              "--prefix",
              `${root}/runtime`,
              "--no-audit",
              "--no-fund",
              "node@24",
            ],
            signal,
          )
          progress("Cloning the repository")
          const work = "/home/agent/workspace"
          const clone = `${work}/${folder}`
          await sbx(["exec", name, "mkdir", "-p", posix.dirname(clone)], signal)

          try {
            await sbx(
              [
                "exec",
                name,
                "git",
                "clone",
                "--quiet",
                "--single-branch",
                "--branch",
                request.baseBranch,
                "--",
                `https://github.com/${request.repository.owner}/${request.repository.repo}.git`,
                clone,
              ],
              signal,
            )
          } catch (error) {
            const github = await sbx(
              ["secret", "ls", "--service", "github", "--global", "--quiet"],
              signal,
            )

            if (
              github.trim() === "" &&
              error instanceof Error &&
              /Repository not found|Authentication failed|could not read Username|terminal prompts disabled/i.test(
                error.message,
              )
            )
              throw glass.missingLogin(
                "GitHub (for private repositories)",
                "sbx --cloud secret set github",
              )
            throw error
          }

          await sbx(
            [
              "exec",
              "--workdir",
              clone,
              name,
              "git",
              "checkout",
              "--quiet",
              "-b",
              request.branch,
              `origin/${request.baseBranch}`,
            ],
            signal,
          )
          const config = join(temporary, "host.json")
          await writeFile(
            config,
            JSON.stringify({ cwd: work, environment: request.host.environment }),
            { mode: 0o600 },
          )
          await sbx(["cp", request.host.bundle, `${name}:${root}/agentHost.mjs`], signal)
          await sbx(
            ["cp", join(import.meta.dirname, "launch.mjs"), `${name}:${root}/launch.mjs`],
            signal,
          )
          await sbx(["cp", config, `${name}:${root}/host.json`], signal)
          progress("Starting the OpenCode Agent host")
          await sbx(["exec", name, node, `${root}/launch.mjs`], signal)
          await sbx(["ports", name, "--publish", String(request.host.port)], signal)
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      } catch (error) {
        if (
          /not logged in|unauthorized|authentication required|no active subscription/i.test(
            error instanceof Error ? error.message : "",
          )
        )
          throw glass.missingLogin("Docker Cloud", "sbx login; sbx --cloud diagnose")

        if (
          /quota|no capacity|capacity exceeded|resource limit/i.test(
            error instanceof Error ? error.message : "",
          )
        )
          throw glass.noCapacity("Docker Cloud has no capacity for this Sandbox.")
        throw error
      } finally {
        pendingCreates.delete(name)
      }
    },
    target: async (state) => {
      const { name, port } = stateOf(state)
      const info = await inspect(name)

      if (info.state === "deleted") throw glass.sandboxGone()

      if (info.state !== "running") throw new Error(`Docker Sandbox is ${info.state}`)

      const published: unknown = info.ports.find(
        (item) => typeof item === "object" && item !== null && "port" in item && item.port === port,
      )

      if (
        typeof published !== "object" ||
        published === null ||
        !("url" in published) ||
        typeof published.url !== "string"
      )
        throw new Error("Docker hasn't published the Glass host port")
      const url = new URL(published.url)

      if (url.protocol !== "https:") throw new Error("Docker returned an insecure host URL")

      return { url: url.href, headers: {} }
    },
    extend: async (state) => {
      const info = await inspect(stateOf(state).name)
      const expiry = new Date(info.expires_at)

      if (!Number.isFinite(expiry.getTime())) throw new Error("Docker returned an invalid expiry")

      return expiry
    },
    remove: async (state) => {
      const { name } = stateOf(state)
      await pendingCreates.get(name)?.catch(() => {})

      try {
        await sbx(["rm", "--force", name])
      } catch (error) {
        if (error instanceof Error && isGone(error, name)) throw glass.sandboxGone()
        throw error
      }

      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          if (parseInspection(await sbx(["inspect", name, "--json"])).state === "deleted") return
        } catch (error) {
          if (error instanceof Error && isGone(error, name)) return
          throw error
        }

        await setTimeout(500)
      }

      throw new Error(
        "Docker accepted deletion but hasn't confirmed that the Sandbox is gone. Retry Remove.",
      )
    },
  }
}

const pendingCreates = new Map<string, Promise<string>>()

const plugin: Plugin = (glass) =>
  glass.registerSandboxProvider("docker-cloud", dockerProvider(glass))

export default plugin
