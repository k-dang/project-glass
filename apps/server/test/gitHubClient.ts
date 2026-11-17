import { Context, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { GitHubAuth } from "../src/github/GitHubAuth"
import { GitHubClient } from "../src/github/GitHubClient"
import { ServerConfig } from "../src/ServerConfig"

export const clientWith = Effect.fnUntraced(function* (
  fetch: typeof globalThis.fetch,
  auth: GitHubAuth["Service"] = {
    resolveToken: Effect.succeed({ token: Redacted.make("test-token"), source: "gh" as const }),
  },
) {
  const services = yield* Layer.build(
    GitHubClient.layer.pipe(
      Layer.provide(Layer.succeed(GitHubAuth, auth)),
      Layer.provide(
        Layer.succeed(ServerConfig, {
          port: 0,
          token: Redacted.make("test-launch-token"),
          allowedOrigins: new Set<string>(),
          githubApiUrl: "http://127.0.0.1",
          agentHostBundle: "agentHost.mjs",
          gitRemote: "https://github.com",
          dataDirectory: "",
          homeDirectory: "",
        }),
      ),
    ),
  ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))

  return Context.get(services, GitHubClient)
})
