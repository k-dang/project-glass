import { NoCredentials, type TokenSource } from "@glass/contracts"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface ResolvedToken {
  readonly token: Redacted.Redacted
  readonly source: TokenSource
}

const fromEnv = (name: "GH_TOKEN" | "GITHUB_TOKEN") =>
  Config.option(Config.NonEmptyString(name)).pipe(
    Effect.map(
      Option.map((token): ResolvedToken => ({ token: Redacted.make(token), source: name })),
    ),
    Effect.orElseSucceed(() => Option.none<ResolvedToken>()),
  )

export class GitHubAuth extends Context.Service<
  GitHubAuth,
  {
    readonly resolveToken: Effect.Effect<ResolvedToken, NoCredentials>
  }
>()("@glass/server/github/GitHubAuth") {
  static readonly layer = Layer.effect(
    GitHubAuth,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const fromGhCli = spawner.string(ChildProcess.make("gh", ["auth", "token"])).pipe(
        Effect.map((output) => output.trim()),
        Effect.map((token) =>
          token.length > 0
            ? Option.some<ResolvedToken>({ token: Redacted.make(token), source: "gh" })
            : Option.none<ResolvedToken>(),
        ),
        Effect.orElseSucceed(() => Option.none<ResolvedToken>()),
      )

      const resolveToken = Effect.gen(function* () {
        for (const candidate of [fromEnv("GH_TOKEN"), fromEnv("GITHUB_TOKEN"), fromGhCli]) {
          const resolved = yield* candidate

          if (Option.isSome(resolved)) return resolved.value
        }

        return yield* new NoCredentials()
      }).pipe(Effect.withSpan("GitHubAuth.resolveToken"))

      return GitHubAuth.of({ resolveToken })
    }),
  )
}
