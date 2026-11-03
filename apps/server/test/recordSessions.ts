import { spawnSync } from "node:child_process"

const USAGE = `Records the Agent session recordings that the adapter integration tests replay.

  pnpm --filter @glass/server record:sessions [claude|pi] [--pi-model <provider/model>] [vitest options, such as -t <test name>]

Recording costs a few cents. Claude Code sessions run the pinned claude on Haiku with your own
Claude Code login, from ~/.claude/.credentials.json or, on macOS, the Keychain; set
CLAUDE_CODE_OAUTH_TOKEN where your login is in neither. pi sessions, which need --pi-model, run
the bundled pi on the model you name, with whatever login your own pi has for it: its auth.json
and models.json, environment variables, or an AWS or Google Cloud login. Pick a cheap model that
reasons and reads images; recordings name it and its provider only by placeholder. Fields that
look personal (email, org, account, rate limits) are blanked and usage counters and costs are
zeroed; check the files before committing them.`

const pnpmPath = process.env["npm_execpath"]

const given = process.argv.slice(2)

const piModelFlag = given.indexOf("--pi-model")

const piModel = piModelFlag === -1 ? undefined : given[piModelFlag + 1]

const options = piModelFlag === -1 ? given : given.toSpliced(piModelFlag, 2)

const [engine, ...rest] = options

if (engine === "--help") {
  console.log(USAGE)
  process.exit(0)
}

if (!pnpmPath || (engine !== "claude" && !piModel?.includes("/"))) {
  console.log(USAGE)
  process.exit(1)
}

const vp = (...args: Array<string>) =>
  spawnSync(process.execPath, [pnpmPath, "exec", "vp", ...args], {
    stdio: "inherit",
    env: { ...process.env, GLASS_RECORD_SESSIONS: "1", GLASS_RECORD_PI_MODEL: piModel },
  }).status

const tests =
  engine === "claude" || engine === "pi"
    ? vp("test", "run", `${engine}Adapter.integration`, ...rest)
    : vp("test", "run", "Adapter.integration", ...options)

const format = vp("fmt", "test/recordings/sessions")

process.exit(tests || format || 0)
