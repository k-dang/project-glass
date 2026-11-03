import { spawnSync } from "node:child_process"

const USAGE = `Records the Agent session recordings that the adapter integration tests replay.

  pnpm --filter @glass/server record:sessions [claude|pi] [vitest options, such as -t <test name>]

Claude Code sessions run the pinned claude on your own Claude Code login with Haiku, which costs a
few cents; set CLAUDE_CODE_OAUTH_TOKEN where your login isn't in ~/.claude/.credentials.json. pi
sessions run the bundled pi against a fake model API. Fields that look personal (email, org,
account, rate limits) are blanked; check the files before committing them.`

const pnpmPath = process.env["npm_execpath"]

const [engine, ...rest] = process.argv.slice(2)

if (engine === "--help") {
  console.log(USAGE)
  process.exit(0)
}

if (!pnpmPath) {
  console.log(USAGE)
  process.exit(1)
}

const vp = (...args: Array<string>) =>
  spawnSync(process.execPath, [pnpmPath, "exec", "vp", ...args], {
    stdio: "inherit",
    env: { ...process.env, GLASS_RECORD_SESSIONS: "1" },
  }).status

const tests =
  engine === "claude" || engine === "pi"
    ? vp("test", "run", `${engine}Adapter.integration`, ...rest)
    : vp("test", "run", "Adapter.integration", ...process.argv.slice(2))

const format = vp("fmt", "test/recordings/sessions")

process.exit(tests || format || 0)
