import { Clock, Context, Data, Effect, Layer, Option, Schema, Semaphore } from "effect"

export const BackgroundGitHubRequest = Context.Reference<boolean>(
  "@glass/server/BackgroundGitHubRequest",
  { defaultValue: () => false },
)

export class GitHubRequestPaused extends Data.TaggedError("GitHubRequestPaused")<{
  readonly retryAt: number
}> {}

const QuotaHeaders = Schema.Struct({
  limit: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
  remaining: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  reset: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 8_640_000_000_000 }),
  ),
})

export const GitHubErrorResponse = Schema.Struct({
  message: Schema.optional(Schema.String),
  errors: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String), message: Schema.String })),
  ),
})

interface Quota {
  readonly limit: number
  readonly remaining: number
  readonly resetAt: number
}

interface Pause {
  readonly retryAt: number
  readonly attempt: number
}

type Resource = "core" | "graphql"

export class GitHubRequestPolicy extends Context.Service<
  GitHubRequestPolicy,
  {
    readonly run: <A, E, R>(
      credential: string,
      resource: Resource,
      request: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitHubRequestPaused, R>
    readonly observe: (
      credential: string,
      resource: Resource,
      status: number,
      headers: Readonly<Record<string, string | undefined>>,
      error: typeof GitHubErrorResponse.Type | undefined,
    ) => Effect.Effect<void, GitHubRequestPaused>
  }
>()("@glass/server/GitHubRequestPolicy") {
  static readonly layer = Layer.effect(
    GitHubRequestPolicy,
    Effect.gen(function* () {
      const slots = yield* Semaphore.make(4)
      const quotas = new Map<string, Quota>()
      const pauses = new Map<string, Pause>()

      const run = <A, E, R>(
        credential: string,
        resource: "core" | "graphql",
        request: Effect.Effect<A, E, R>,
      ) =>
        slots.withPermit(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const pause = pauses.get(credential)

            if (pause !== undefined && pause.retryAt > now) {
              return yield* new GitHubRequestPaused({ retryAt: pause.retryAt })
            }

            const quota = quotas.get(`${credential}:${resource}`)
            const background = yield* BackgroundGitHubRequest

            if (
              quota !== undefined &&
              quota.resetAt > now &&
              quota.remaining < (background ? Math.max(1, quota.limit * 0.1) : 1)
            ) {
              return yield* new GitHubRequestPaused({ retryAt: quota.resetAt })
            }

            return yield* request.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (pause !== undefined && pauses.get(credential) === pause) {
                    pauses.delete(credential)
                  }
                }),
              ),
            )
          }),
        )

      const observe = Effect.fnUntraced(function* (
        credential: string,
        resource: "core" | "graphql",
        status: number,
        headers: Readonly<Record<string, string | undefined>>,
        error: typeof GitHubErrorResponse.Type | undefined,
      ) {
        const now = yield* Clock.currentTimeMillis

        const parsed = Schema.decodeUnknownOption(QuotaHeaders)({
          limit: headers["x-ratelimit-limit"],
          remaining: headers["x-ratelimit-remaining"],
          reset: headers["x-ratelimit-reset"],
        })

        if (Option.isSome(parsed)) {
          const quota = { ...parsed.value, resetAt: parsed.value.reset * 1000 }
          const key = `${credential}:${resource}`
          const previous = quotas.get(key)

          if (previous === undefined || quota.resetAt >= previous.resetAt) quotas.set(key, quota)
        }

        const limited =
          status === 429 ||
          (status === 403 &&
            (headers["x-ratelimit-remaining"] === "0" ||
              headers["retry-after"] !== undefined ||
              /rate limit|abuse/i.test(error?.message ?? ""))) ||
          error?.errors?.some(
            (item) => item.type === "RATE_LIMITED" || /rate limit/i.test(item.message),
          )

        if (!limited) return yield* Effect.void

        const previous = pauses.get(credential)

        // Concurrent refusals belong to the same cooldown, not successive retry attempts.
        const attempt =
          previous !== undefined && previous.retryAt > now
            ? previous.attempt
            : (previous?.attempt ?? 0) + 1

        const retryAfter = headers["retry-after"]?.trim()

        const seconds =
          retryAfter === undefined || !/^\d+$/.test(retryAfter) ? NaN : Number(retryAfter)

        const retryAt =
          Number.isSafeInteger(seconds) && seconds >= 0 && seconds < 8_640_000_000_000
            ? now + seconds * 1000
            : retryAfter === undefined
              ? NaN
              : Date.parse(retryAfter)

        const resetAt = Option.isSome(parsed) ? parsed.value.reset * 1000 : NaN

        const deadline =
          Number.isFinite(retryAt) && retryAt > now
            ? retryAt
            : resetAt > now
              ? resetAt
              : now + Math.min(60_000 * 2 ** Math.min(attempt - 1, 4), 15 * 60_000)

        const pause = { attempt, retryAt: Math.max(previous?.retryAt ?? 0, deadline) }
        pauses.set(credential, pause)

        return yield* new GitHubRequestPaused({ retryAt: pause.retryAt })
      })

      return GitHubRequestPolicy.of({ run, observe })
    }),
  )
}
