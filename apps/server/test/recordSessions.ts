import { spawnSync } from "node:child_process"

const pnpmPath = process.env["npm_execpath"]

if (!pnpmPath) throw new Error("Record sessions with pnpm --filter @glass/server record:sessions")

const vp = (...args: Array<string>) =>
  spawnSync(process.execPath, [pnpmPath, "exec", "vp", ...args], {
    stdio: "inherit",
    env: { ...process.env, GLASS_RECORD_SESSIONS: "1" },
  }).status

const tests = vp("test", "run", "Adapter.integration", ...process.argv.slice(2))

const format = vp("fmt", "test/recordings/sessions")

process.exit(tests || format || 0)
