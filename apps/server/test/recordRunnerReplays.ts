import type { EngineModels } from "@glass/contracts"
import { Effect, Schema } from "effect"
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { AgentRunners } from "../src/agentRunners"
import { sdkExecutable } from "../src/processes"
import {
  Recording,
  type RunnerScenario,
  recordingFile,
  recordingSpawner,
  runnerScenarios,
  runnersLayer,
  seedCheckout,
} from "./runnerReplay"

const USAGE = `Records how the real Claude Code and pi CLIs answer Glass's agent runners.

  pnpm --filter @glass/server exec jiti test/recordRunnerReplays.ts --pi-model <provider/model> [--claude-model haiku] [--only <scenario>]

Uses your own claude and pi logins (GLASS_CLAUDE_COMMAND and GLASS_PI_COMMAND pick other
executables) and writes test/recordings/runners/<scenario>.json. Pick cheap models. Fields
that look personal (email, org, account) are blanked; check the files before committing them.`

const { values } = parseArgs({
  options: {
    "claude-model": { type: "string", default: "haiku" },
    "pi-model": { type: "string" },
    only: { type: "string" },
    help: { type: "boolean" },
  },
})

if (values.help || values["pi-model"] === undefined) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}

const [provider, ...modelId] = values["pi-model"].split("/")

const repository = fileURLToPath(new URL("../../..", import.meta.url)).toLowerCase()

// `pnpm exec` puts the repo's own bins, the bundled pi among them, ahead of the user's programs.
for (const name of Object.keys(process.env).filter((key) => key.toUpperCase() === "PATH"))
  process.env[name] = process.env[name]
    ?.split(delimiter)
    .filter((entry) => !resolve(entry).toLowerCase().startsWith(repository))
    .join(delimiter)

const commands = {
  "claude-code": process.env["GLASS_CLAUDE_COMMAND"] ?? "claude",
  pi: process.env["GLASS_PI_COMMAND"] ?? "pi",
}

const version = (command: string) =>
  execSync(`"${command}" --version`, { encoding: "utf8" }).trim().split("\n")[0]!

const applyEnv = (env: Readonly<Record<string, string | undefined>>) => {
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
}

const withEnv = <A>(env: Readonly<Record<string, string | undefined>>, run: () => Promise<A>) => {
  const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]))

  applyEnv(env)

  return run().finally(() => applyEnv(saved))
}

const record = async (scenario: RunnerScenario) => {
  const models: EngineModels = {
    "claude-code": values["claude-model"],
    pi: { provider: provider!, modelId: scenario.piModelId ?? modelId.join("/") },
  }

  const checkout = mkdtempSync(join(tmpdir(), "glass-recording-"))
  seedCheckout(checkout)
  const recorder = recordingSpawner({ "<checkout>": checkout, "<home>": homedir() })

  const outcome = await withEnv(scenario.recordEnv ?? {}, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* (yield* AgentRunners).select({ engine: scenario.engine, models })

        return yield* runner.run(scenario.task(checkout))
      }).pipe(
        Effect.scoped,
        Effect.match({
          onSuccess: (answer) => ({ answer }),
          onFailure: (failure) => ({ failure: failure.reason }),
        }),
        Effect.provide(
          runnersLayer(
            {
              GLASS_HOME: checkout,
              GLASS_CLAUDE_COMMAND: sdkExecutable(commands["claude-code"]),
              GLASS_PI_COMMAND: sdkExecutable(commands.pi),
            },
            recorder.layer,
          ),
        ),
      ),
    ),
  )

  rmSync(checkout, { recursive: true, force: true })

  const recording = Schema.encodeSync(Recording)({
    scenario: scenario.name,
    program: version(commands[scenario.engine]),
    models,
    outcome,
    spawns: recorder.spawns,
  })

  const file = fileURLToPath(recordingFile(scenario.name))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`)
  console.log(`${scenario.name}: ${JSON.stringify(outcome)}`)
}

for (const scenario of runnerScenarios)
  if (values.only === undefined || values.only === scenario.name) await record(scenario)
