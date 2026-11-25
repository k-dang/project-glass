import { assert, it } from "@effect/vitest"
import { defaultReviewPrompt, PullRequestRef, Revision, runnerIdentity } from "@glass/contracts"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { agentFailure, type AgentFailure } from "./agentFailure"
import { AgentRunners } from "./agentRunners"
import { CheckoutFailure, Checkouts } from "./Checkouts"
import { CheckoutRuns } from "./CheckoutRuns"
import { engineSettingsOf, type Settings, SettingsStore } from "./SettingsStore"

const models = {
  "claude-code": "claude-sonnet-5-5",
  pi: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
}

const settings: Settings = {
  followedRepositories: [],
  tourModels: models,
  tourEngine: "claude-code",
  queueTours: false,
  agentReviewModels: models,
  agentReviewEngine: "pi",
  queueAgentReviews: false,
  reviewPrompt: defaultReviewPrompt,
  claudeCommand: "claude",
  piCommand: "pi",
}

const identity = runnerIdentity(engineSettingsOf(settings, "tours"))

const gate = <A, E = never>() =>
  Effect.all({
    started: Deferred.make<void>(),
    outcome: Deferred.make<A, E>(),
    stopped: Deferred.make<void>(),
  })

type Gate<A, E> = Effect.Success<ReturnType<typeof gate<A, E>>>

const pass = <A, E>(gated: Gate<A, E>) =>
  Deferred.succeed(gated.started, undefined).pipe(
    Effect.andThen(Deferred.await(gated.outcome)),
    Effect.onInterrupt(() => Deferred.succeed(gated.stopped, undefined)),
  )

const fixture = Effect.gen(function* () {
  const readiness = yield* gate<void, AgentFailure>()
  const checkout = yield* gate<string, CheckoutFailure>()
  const material = yield* gate<string>()
  const acquired = yield* Deferred.make<void>()
  const released = yield* Deferred.make<void>()
  const readied = yield* Deferred.make<void>()
  const agentTasks: Array<{ readonly prompt: string; readonly checkout: string }> = []

  const layer = CheckoutRuns.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          SettingsStore,
          SettingsStore.of({
            read: () => Effect.succeed(settings),
            update: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(
          AgentRunners,
          AgentRunners.of({
            select: () =>
              pass(readiness).pipe(
                Effect.as({
                  identity,
                  run: (task) =>
                    Effect.suspend(() => {
                      agentTasks.push({ prompt: task.prompt, checkout: task.checkout })

                      return Schema.decodeUnknownEffect(task.answer)("An answer.").pipe(
                        Effect.orDie,
                      )
                    }),
                }),
              ),
          }),
        ),
        Layer.succeed(
          Checkouts,
          Checkouts.of({
            checkout: () =>
              Effect.acquireRelease(
                pass(checkout).pipe(Effect.tap(() => Deferred.succeed(acquired, undefined))),
                () => Deferred.succeed(released, undefined),
              ),
            checkoutInto: () => Effect.die("unused"),
            checkoutAt: () => Effect.die("unused"),
          }),
        ),
      ),
    ),
  )

  const runs = yield* CheckoutRuns.pipe(Effect.provide(layer))

  const running = yield* runs.select("tours").pipe(
    Effect.flatMap((runner) =>
      runner.run({
        pr: new PullRequestRef({ owner: "octo", repo: "greet", number: 1 }),
        revision: new Revision({ base: "b0", head: "h1" }),
        subject: "Tour",
        timeout: "1 hour",
        read: () => pass(material),
        ready: Deferred.succeed(readied, undefined),
        task: (input) =>
          Effect.succeed({
            instructions: "Write a Tour.",
            prompt: input,
            answer: Schema.String,
            tools: "read-only",
          }),
      }),
    ),
    Effect.forkChild,
  )

  return {
    readiness,
    checkout,
    material,
    acquired,
    released,
    readied,
    agentTasks,
    running,
  }
})

it.effect("prepares the checkout and PR material while the runner's readiness check runs", () =>
  Effect.gen(function* () {
    const f = yield* fixture

    yield* Deferred.await(f.readiness.started)
    yield* Deferred.await(f.checkout.started)
    yield* Deferred.await(f.material.started)
    assert.isFalse(yield* Deferred.isDone(f.readied))
    yield* Deferred.succeed(f.checkout.outcome, "/checkout")
    yield* Deferred.succeed(f.material.outcome, "The PR's material.")
    yield* Deferred.succeed(f.readiness.outcome, undefined)

    const { input, answer } = yield* Fiber.join(f.running)

    assert.strictEqual(input, "The PR's material.")
    assert.strictEqual(answer, "An answer.")
    assert.deepStrictEqual(f.agentTasks, [{ prompt: "The PR's material.", checkout: "/checkout" }])
    assert.isTrue(yield* Deferred.isDone(f.readied))
    assert.isTrue(yield* Deferred.isDone(f.released))
  }),
)

it.effect("a readiness failure stops the PR material read and removes the prepared checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture

    yield* Deferred.await(f.material.started)
    yield* Deferred.succeed(f.checkout.outcome, "/checkout")
    yield* Deferred.await(f.acquired)
    yield* Deferred.fail(f.readiness.outcome, agentFailure("not-installed", "pi is not installed."))

    const failure = yield* Fiber.join(f.running).pipe(Effect.flip)

    assert.strictEqual(failure.reason, "not-ready")
    assert.isNull(failure.runner)
    assert.isTrue(yield* Deferred.isDone(f.material.stopped))
    assert.isTrue(yield* Deferred.isDone(f.released))
    assert.isFalse(yield* Deferred.isDone(f.readied))
    assert.isEmpty(f.agentTasks)
  }),
)

it.effect("a checkout failure stops the readiness check and the PR material read", () =>
  Effect.gen(function* () {
    const f = yield* fixture

    yield* Deferred.await(f.readiness.started)
    yield* Deferred.await(f.material.started)
    yield* Deferred.fail(f.checkout.outcome, new CheckoutFailure({ reason: "unreachable" }))

    const failure = yield* Fiber.join(f.running).pipe(Effect.flip)

    assert.strictEqual(failure.reason, "fetch-failed")
    assert.deepStrictEqual(failure.runner, identity)
    assert.isTrue(yield* Deferred.isDone(f.readiness.stopped))
    assert.isTrue(yield* Deferred.isDone(f.material.stopped))
    assert.isEmpty(f.agentTasks)
  }),
)
