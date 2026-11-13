import { spawn } from "node:child_process"
import { once } from "node:events"
import { open, readFile, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

const root = import.meta.dirname

const path = join(root, "host.json")

const config = JSON.parse(await readFile(path, "utf8"))

await unlink(path)

await writeFile(join(root, "opencode.json"), JSON.stringify({ model: "opencode/big-pickle" }))

const node = join(root, "runtime/node_modules/node/bin/node")

const log = await open(join(root, "host.log"), "a", 0o600)

try {
  const child = spawn(node, [join(root, "agentHost.mjs")], {
    cwd: config.cwd,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: {
      ...process.env,
      ...config.environment,
      GLASS_OPENCODE_COMMAND: "opencode",
      OPENCODE_CONFIG: join(root, "opencode.json"),
      PATH: `${join(root, "runtime/node_modules/node/bin")}:${process.env.PATH}`,
    },
  })

  await once(child, "spawn")
  child.unref()
} finally {
  await log.close()
}
