import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export default function buildBundles() {
  execFileSync("pnpm", ["exec", "vp", "pack"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "ignore",
  })
}
