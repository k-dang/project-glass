import { NodeServices } from "@effect/platform-node"
import type { EngineModels } from "@glass/contracts"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { AgentRunners } from "../src/agentRunners"
import { sdkExecutable } from "../src/processes"
import { ServerConfig } from "../src/ServerConfig"
import {
  Recording,
  type RunnerScenario,
  recordingFile,
  recordingSpawner,
  runnerScenarios,
} from "./runnerReplay"

const USAGE = `Records how the real Claude Code and pi CLIs answer Glass's agent runners.

  pnpm --filter @glass/server exec jiti test/recordRunnerReplays.ts --pi-model <provider/model> [--claude-model haiku] [--only <scenario>]

Uses your own claude and pi logins (GLASS_CLAUDE_COMMAND and GLASS_PI_COMMAND pick other
executables) and writes test/recordings/runners/<scenario>.json. Pick cheap models.`

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
  mkdirSync(join(checkout, "src"))
  writeFileSync(join(checkout, "src", "greet.ts"), "hello")
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
          AgentRunners.layer.pipe(
            Layer.provide(recorder.layer),
            Layer.provide(ServerConfig.layer),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnvRecord({
                  GLASS_PORT: "0",
                  GLASS_TOKEN: "unused",
                  GLASS_HOME: checkout,
                  GLASS_CLAUDE_COMMAND: sdkExecutable(commands["claude-code"]),
                  GLASS_PI_COMMAND: sdkExecutable(commands.pi),
                }),
              ),
            ),
            Layer.provide(NodeServices.layer),
            Layer.orDie,
          ),
        ),
      ),
    ),
  )

  rmSync(checkout, { recursive: true, force: true })

  const recording = Schema.encodeSync(Schema.fromJsonString(Recording))({
    scenario: scenario.name,
    program: version(commands[scenario.engine]),
    models,
    outcome,
    spawns: recorder.spawns,
  })

  const file = fileURLToPath(recordingFile(scenario.name))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(JSON.parse(recording), null, 2)}\n`)
  console.log(`${scenario.name}: ${JSON.stringify(outcome)}`)
}

for (const scenario of runnerScenarios)
  if (values.only === undefined || values.only === scenario.name) await record(scenario)
