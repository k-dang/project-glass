import { Schema } from "effect"

export const TokenSource = Schema.Literals(["GH_TOKEN", "GITHUB_TOKEN", "gh"])

export type TokenSource = typeof TokenSource.Type

export class GitHubConnection extends Schema.Class<GitHubConnection>("GitHubConnection")({
  login: Schema.String,
  tokenSource: TokenSource,
}) {}

export class NoCredentials extends Schema.TaggedError<NoCredentials>()("NoCredentials", {}) {}

export class TokenRejected extends Schema.TaggedError<TokenRejected>()("TokenRejected", {
  tokenSource: TokenSource,
}) {}

export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable>()(
  "GitHubUnavailable",
  { message: Schema.String },
) {}

export const ConnectionError = Schema.Union([NoCredentials, TokenRejected, GitHubUnavailable])

export type ConnectionError = typeof ConnectionError.Type
