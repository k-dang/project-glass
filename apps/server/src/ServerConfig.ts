import { Config, Context, Effect, Layer, type Redacted, Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

export class ServerConfig extends Context.Service<
  ServerConfig,
  {
    readonly port: number
    readonly token: Redacted.Redacted
    readonly allowedOrigins: ReadonlySet<string>
    readonly githubApiUrl: string
    readonly claudeCommand: string
    readonly piCommand: string
    readonly tourTimeoutMs: number
    readonly agentReviewTimeoutMs: number
    readonly askTimeoutMs: number
    readonly gitRemote: string
    readonly checkoutTimeoutMs: number
    readonly dataDirectory: string
  }
>()("@glass/server/ServerConfig") {
  static readonly layer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const port = yield* Config.Int("GLASS_PORT")
      const token = yield* Config.Redacted("GLASS_TOKEN")

      const claudeCommand = yield* Config.String("GLASS_CLAUDE_COMMAND").pipe(
        Config.withDefault("claude"),
      )

      const piCommand = yield* Config.String("GLASS_PI_COMMAND").pipe(Config.withDefault("pi"))

      const tourTimeoutMs = yield* Config.schema(
        Schema.Int.check(Schema.isGreaterThan(0)),
        "GLASS_TOUR_TIMEOUT_MS",
      ).pipe(Config.withDefault(300_000))

      const agentReviewTimeoutMs = yield* Config.schema(
        Schema.Int.check(Schema.isGreaterThan(0)),
        "GLASS_AGENT_REVIEW_TIMEOUT_MS",
      ).pipe(Config.withDefault(900_000))

      const askTimeoutMs = yield* Config.schema(
        Schema.Int.check(Schema.isGreaterThan(0)),
        "GLASS_ASK_TIMEOUT_MS",
      ).pipe(Config.withDefault(300_000))

      const gitRemote = yield* Config.String("GLASS_GIT_REMOTE").pipe(
        Config.withDefault("https://github.com"),
      )

      const checkoutTimeoutMs = yield* Config.schema(
        Schema.Int.check(Schema.isGreaterThan(0)),
        "GLASS_CHECKOUT_TIMEOUT_MS",
      ).pipe(Config.withDefault(300_000))

      const allowedOrigins = yield* Config.String("GLASS_ALLOWED_ORIGINS").pipe(
        Config.withDefault(""),
      )

      const githubApiUrl = yield* Config.String("GLASS_GITHUB_API_URL").pipe(
        Config.withDefault("https://api.github.com"),
      )

      const home = yield* Config.String("GLASS_HOME").pipe(Config.withDefault(""))

      return ServerConfig.of({
        port,
        token,
        allowedOrigins: new Set(
          allowedOrigins
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0),
        ),
        githubApiUrl,
        claudeCommand,
        piCommand,
        tourTimeoutMs,
        agentReviewTimeoutMs,
        askTimeoutMs,
        gitRemote,
        checkoutTimeoutMs,
        dataDirectory: join(home || homedir(), ".project-glass"),
      })
    }),
  )
}
