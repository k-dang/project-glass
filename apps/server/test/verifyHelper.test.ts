import { assert, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const helper = fileURLToPath(
  new URL("../../../.agents/skills/verify-glass/scripts/glass-verify.ts", import.meta.url),
)

it("loads the verify-glass helper under plain Node", () => {
  const result = spawnSync(process.execPath, [helper, "help"], { encoding: "utf8" })

  assert.strictEqual(result.status, 0, result.stderr)
})
