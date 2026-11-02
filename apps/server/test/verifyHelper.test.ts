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

it("defaults GitHub to fake and preserves intentional real selection", async () => {
  const { githubMode } = await import("../../../.agents/skills/verify-glass/scripts/launch-options")
  assert.strictEqual(githubMode(undefined, "real"), "fake")
  assert.strictEqual(githubMode("real", "real"), "real")
  assert.strictEqual(githubMode("fake", "real"), "fake")
  assert.strictEqual(githubMode(undefined, "fake"), "fake")
  assert.strictEqual(githubMode("real", "fake"), "real")
  assert.throws(() => githubMode("fake", "fake"), /brings its own fake GitHub/)
  assert.throws(() => githubMode("invalid", "real"), /--github is real or fake/)
})
