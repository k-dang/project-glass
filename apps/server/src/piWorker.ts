import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { Effect, Result, Schema } from "effect"
import { closeSync, writeSync } from "node:fs"
import { text } from "node:stream/consumers"
import { agentFailure } from "./agentFailure"
import { PiAnswerJson, PiConfigJson, PiReady, PiRequest } from "./piProtocol"

const prepare = Effect.gen(function* () {
  const { provider, modelId } = yield* Schema.decodeUnknownEffect(PiConfigJson)(
    process.argv[2],
  ).pipe(Effect.mapError(() => agentFailure("failed", "The Pi worker configuration is invalid.")))

  const model = `${provider}/${modelId}`

  const runtime = yield* Effect.tryPromise({
    try: (signal) => ModelRuntime.create({ signal, refreshOnCreate: false }),
    catch: () => agentFailure("not-ready", "pi's model configuration could not be loaded."),
  })

  const refreshed = yield* Effect.tryPromise({
    try: (signal) => runtime.refresh({ providers: [provider], allowNetwork: false, signal }),
    catch: () => agentFailure("not-ready", "pi's model configuration could not be loaded."),
  })

  if (runtime.getError() !== undefined || refreshed.errors.size > 0)
    return yield* agentFailure(
      "not-ready",
      "pi's model configuration could not be loaded. Check its models.json and provider credentials.",
    )

  const selectedModel = runtime.getModel(provider, modelId)

  if (selectedModel === undefined)
    return yield* agentFailure("not-ready", `The Tour model ${model} is not available in pi.`)

  const auth = yield* Effect.tryPromise({
    try: (signal) => runtime.getAuth(selectedModel, { signal }),
    catch: () => agentFailure("not-ready", "pi's authentication could not be checked."),
  })

  if (auth === undefined)
    return yield* agentFailure(
      "not-ready",
      `Sign into ${provider} in pi with /login, then try again.`,
    )

  return { runtime, selectedModel }
})

const prepared = await Effect.runPromise(prepare.pipe(Effect.result))

writeSync(3, Schema.encodeSync(PiReady)(Result.isFailure(prepared) ? prepared.failure : "ready"))

closeSync(3)

if (Result.isSuccess(prepared)) {
  const { runtime, selectedModel } = prepared.success
  const { instructions, prompt } = Schema.decodeUnknownSync(PiRequest)(await text(process.stdin))

  const answer = await runtime
    .completeSimple(
      selectedModel,
      {
        systemPrompt: instructions,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        tools: [],
      },
      { reasoning: "medium", maxRetries: 0 },
    )
    .catch((error) => ({ stopReason: "error", errorMessage: String(error), content: [] }))

  process.stdout.write(Schema.encodeSync(PiAnswerJson)(answer))
}
