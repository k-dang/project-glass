import { Effect, Schema } from "effect"
import { writeFileSync } from "node:fs"
import { fakeModelProvider } from "../../../../apps/server/test/fakeModelProvider.ts"

const material = Schema.fromJsonString(
  Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) }),
)

export const serveFakePi = (home: string, readyFile: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const provider = yield* fakeModelProvider(home, {
          output: ({ messages }) => {
            const prompt = messages.findLast((message) => message.role === "user")?.content ?? ""
            const { files } = Schema.decodeUnknownSync(material)(prompt.split("\n")[1] ?? "")
            console.log(`${new Date().toISOString()} completion -> 200 (${files.length} files)`)

            return JSON.stringify({
              intent: "Synthetic Tour for development verification. No model was called.",
              chapters: [
                {
                  title: "Development Tour",
                  explanation: "These summaries are fixtures for checking the Tour UI.",
                  files: files.map(({ path }) => ({ path, summary: "Synthetic file summary." })),
                },
              ],
              unplacedFiles: [],
            })
          },
        })
        writeFileSync(readyFile, JSON.stringify({ port: Number(new URL(provider.url).port) }))
        yield* Effect.never
      }),
    ),
  )
