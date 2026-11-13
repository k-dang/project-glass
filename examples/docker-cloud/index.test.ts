import { readFile } from "node:fs/promises"
import { expect, it } from "vite-plus/test"
import { dockerProvider, type DockerCommand } from "./index"
import type { Glass, SandboxState } from "./glass-plugin"

const glass: Glass = {
  registerSandboxProvider: () => {},
  missingLogin: (login, fix) => new Error(`${login}: ${fix}`),
  noCapacity: (message) => new Error(message),
  sandboxGone: () => new Error("SandboxGone"),
}

const name = "glass-12345678-1234-1234-1234-123456789abc"

const state = { name, port: 7310 }

it("discovers the bootstrap model without Docker or a local OpenCode installation", async () => {
  const provider = dockerProvider(glass, async () => {
    throw new Error("No process should start")
  })

  expect(provider.engines).toEqual(["opencode"])
  expect(await provider.models("opencode")).toEqual({
    defaultModel: { id: "opencode/big-pickle", name: "Big Pickle", efforts: [] },
    models: [{ id: "opencode/big-pickle", name: "Big Pickle", efforts: [] }],
  })
  expect(await readFile(new URL("./glass-plugin.ts", import.meta.url), "utf8")).toBe(
    await readFile(new URL("../../packages/plugin/src/index.ts", import.meta.url), "utf8"),
  )
})

it("inspects the host address afresh and distinguishes a stopped machine from a gone machine", async () => {
  let status = "running"
  let address = "https://first.sbx.sandboxes-cloud.docker.com"

  const provider = dockerProvider(glass, async () => {
    if (status === "gone") throw new Error(`error: sandbox '${name}' not found`)

    return JSON.stringify({
      state: status,
      expires_at: "2026-11-12T00:00:00Z",
      ports: [{ port: 7310, url: address }],
    })
  })

  expect((await provider.target(state)).url).toBe(`${address}/`)
  address = "https://second.sbx.sandboxes-cloud.docker.com"
  expect((await provider.target(state)).url).toBe(`${address}/`)
  status = "stopped"
  await expect(provider.target(state)).rejects.toThrow("Docker Sandbox is stopped")
  status = "deleted"
  await expect(provider.target(state)).rejects.toThrow("SandboxGone")
  await provider.remove(state)
  status = "gone"
  await expect(provider.target(state)).rejects.toThrow("SandboxGone")
})

it("records before allocation and waits for an accepted create before deleting a cancelled machine", async () => {
  const calls: Array<ReadonlyArray<string>> = []
  let recorded: SandboxState | undefined
  let recordedAtCreate: SandboxState | undefined
  let created: (() => void) | undefined

  const accepting = new Promise<string>((resolve) => {
    created = () => resolve("sbx_test")
  })

  const controller = new AbortController()

  const sbx: DockerCommand = async (args) => {
    calls.push(args)

    if (args[0] === "create") {
      recordedAtCreate = recorded
      controller.abort()

      return accepting
    }

    if (args[0] === "inspect") throw new Error(`error: sandbox '${args[1]}' not found`)

    return ""
  }

  const provider = dockerProvider(glass, sbx)

  const creating = provider.create(
    {
      agentId: "test",
      engine: "opencode",
      repository: { owner: "docker", repo: "welcome-to-docker" },
      baseBranch: "main",
      branch: "test-agent",
      folder: "repository",
      host: { bundle: "unused", port: 7310, environment: {} },
    },
    {
      record: (value) => {
        recorded = value
      },
      progress: () => {},
      signal: controller.signal,
    },
  )

  expect(recordedAtCreate).toEqual(recorded)
  expect(recorded).toBeDefined()
  const removing = provider.remove(recorded!)
  expect(calls.map((args) => args[0])).toEqual(["create"])
  created!()
  await expect(creating).rejects.toThrow("This operation was aborted")
  await removing
  expect(calls.map((args) => args[0])).toEqual(["create", "rm", "inspect"])
})
