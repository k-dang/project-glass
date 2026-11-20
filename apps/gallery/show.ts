import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const page = join(import.meta.dirname, "..", "..", ".gallery", "index.html")

if (!existsSync(page)) {
  console.error(`No gallery at ${page}. Run pnpm gallery:capture first.`)
  process.exit(1)
}

const [command, ...args] =
  process.platform === "win32"
    ? ["cmd", "/c", "start", "", page]
    : [process.platform === "darwin" ? "open" : "xdg-open", page]

spawn(command, args, { stdio: "ignore", detached: true }).unref()

console.log(page)
