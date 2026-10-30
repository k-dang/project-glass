import { Effect, Schema } from "effect"
import { copyFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type RunningHelper = typeof RunningHelper.Type

const RunningHelper = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    parentPid: Schema.Number,
    childPid: Schema.Number,
    cwd: Schema.String,
  }),
)

const shellQuote = (path: string) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`

export const piCredentialHelper = Effect.fnUntraced(function* (home: string) {
  const directory = join(home, ".pi", "agent")
  const path = join(directory, "credential helper.cjs")
  yield* Effect.promise(async () => {
    await copyFile(new URL("./piCredentialHelper.cjs", import.meta.url), path)
    await writeFile(`${path}.key`, "")
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify({
        "glass-test": {
          type: "api_key",
          key: `!${shellQuote(process.execPath)} ${shellQuote(path)}`,
        },
      }),
    )
  })

  return {
    setKey: (key: string) => Effect.promise(() => writeFile(`${path}.key`, key)),
    hang: Effect.promise(() => writeFile(`${path}.hang`, "")),
    running: Effect.promise(() => readFile(`${path}.running`, "utf8")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RunningHelper)),
    ),
  }
})
