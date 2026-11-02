import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { installFakeSandboxProvider } from "./fakeSandboxProvider"
import { isolatedHome } from "./harness"

it.live("kills a Sandbox host's programs even when they have their own process groups", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const root = join(home, "sandboxes")

    const sandboxes = installFakeSandboxProvider(home, {
      root,
      cloneFrom: "unused",
      piCommand: "unused",
      claudeCommand: "unused",
    })

    const program = `
      const server = require("node:net").createServer(socket => {
        socket.on("data", () => socket.write("still running"))
      })
      server.listen(0, "127.0.0.1", () => process.send(server.address().port))
    `

    const host = spawn(
      process.execPath,
      [
        "-e",
        `
          const child = require("node:child_process").spawn(
            process.execPath, ["-e", ${JSON.stringify(program)}],
            { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] }
          )
          child.on("message", port => {
            process.stdout.write(JSON.stringify({ pid: child.pid, port }) + "\\n")
          })
        `,
      ],
      {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "inherit"],
        windowsHide: true,
      },
    )

    const output = createInterface({ input: host.stdout })
    let programPid: number | undefined

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        output.close()
        host.kill("SIGKILL")

        if (programPid !== undefined) {
          try {
            process.kill(programPid, "SIGKILL")
          } catch {}
        }
      }),
    )

    const [line] = yield* Effect.promise(() => once(output, "line"))
    const address: { pid: number; port: number } = JSON.parse(line)
    programPid = address.pid
    const socket = createConnection(address.port, "127.0.0.1")
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()))
    yield* Effect.promise(() => once(socket, "connect"))

    const reply = new Promise<string | null>((resolve) => {
      socket.once("data", (data) => resolve(data.toString()))
      socket.once("close", () => resolve(null))
      socket.once("error", () => resolve(null))
    })

    const folder = join(root, "agent")
    yield* Effect.promise(() => mkdir(folder))
    yield* Effect.promise(() =>
      writeFile(
        join(folder, "host.json"),
        JSON.stringify({ pid: host.pid, port: address.port, token: "test" }),
      ),
    )
    yield* Effect.promise(() => sandboxes.killHost("agent"))
    socket.write("probe")
    assert.isNull(yield* Effect.promise(() => reply))
  }),
)
