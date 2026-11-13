import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { choosePort } from "./backendPort"

const hold = (port: number) =>
  new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
    const server = createServer()

    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(server))
  })

describe("choosePort", () => {
  it("reuses the port it wrote", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glass-port-"))

    try {
      const first = await choosePort(directory)
      const second = await choosePort(directory)

      expect(second).toBe(first)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("picks another port when the remembered one is taken", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glass-port-"))
    const first = await choosePort(directory)
    const taken = await hold(first)

    try {
      const second = await choosePort(directory)

      expect(second).not.toBe(first)
    } finally {
      taken.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
