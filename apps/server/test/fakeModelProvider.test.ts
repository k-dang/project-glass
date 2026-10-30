import { assert, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { fakeModelProvider } from "./fakeModelProvider"
import { isolatedHome } from "./harness"

it.live("generates one model answer when a request is answered, including a held request", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    let generated = 0
    const output = () => `answer-${++generated}`
    const provider = yield* fakeModelProvider(home, { output })

    const request = Effect.promise(async () => {
      const response = await fetch(`${provider.url}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-test", messages: [] }),
      })

      return response.text()
    })

    assert.include(yield* request, '"content":"answer-1"')
    assert.equal(generated, 1)

    yield* provider.configure({ output, hang: true })
    const held = yield* request.pipe(Effect.forkChild)
    yield* provider.received(2)
    assert.equal(generated, 1)
    yield* provider.release({ output })
    assert.include(yield* Fiber.join(held), '"content":"answer-2"')
    assert.equal(generated, 2)
  }),
)
