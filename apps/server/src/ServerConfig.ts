import { Config, Context, Effect, Layer, type Redacted } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { bundledEntry } from "./processes"

export const Deadlines = Context.Reference<{
  readonly tourMs: number
  readonly agentReviewMs: number
  readonly askMs: number
  readonly checkoutMs: number
}>("@glass/server/Deadlines", {
  defaultValue: () => ({
    tourMs: 900_000,
    agentReviewMs: 900_000,
    askMs: 300_000,
    checkoutMs: 300_000,
  }),
})

export class ServerConfig extends Context.Service<
  ServerConfig,
  {
    readonly port: number
    readonly token: Redacted.Redacted
    readonly allowedOrigins: ReadonlySet<string>
    readonly githubApiUrl: string
    readonly agentHostBundle: string
    readonly gitRemote: string
    readonly dataDirectory: string
    /** The user's home folder, where the Agent programs read their Local skills. */
    readonly homeDirectory: string
  }
>()("@glass/server/ServerConfig") {
  static readonly layer = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const port = yield* Config.Int("GLASS_PORT")
      const token = yield* Config.Redacted("GLASS_TOKEN")

      const gitRemote = yield* Config.String("GLASS_GIT_REMOTE").pipe(
        Config.withDefault("https://github.com"),
      )

      const allowedOrigins = yield* Config.String("GLASS_ALLOWED_ORIGINS").pipe(
        Config.withDefault(""),
      )

      const githubApiUrl = yield* Config.String("GLASS_GITHUB_API_URL").pipe(
        Config.withDefault("https://api.github.com"),
      )

      const homeDirectory =
        (yield* Config.String("GLASS_HOME").pipe(Config.withDefault(""))) || homedir()

      const agentHostBundle = yield* Config.String("GLASS_AGENT_HOST_BUNDLE").pipe(
        Config.withDefault(bundledEntry("agentHost", import.meta.url)),
      )

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
        agentHostBundle,
        gitRemote,
        dataDirectory: join(homeDirectory, ".project-glass"),
        homeDirectory,
      })
    }),
  )
}
