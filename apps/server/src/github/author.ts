import { Schema } from "effect"

export const GitHubAuthor = Schema.NullOr(
  Schema.Struct({ login: Schema.String, avatarUrl: Schema.optional(Schema.String) }),
)

export const login = (author: typeof GitHubAuthor.Type) => author?.login ?? "ghost"

export const avatarUrl = (author: typeof GitHubAuthor.Type) => author?.avatarUrl ?? null
