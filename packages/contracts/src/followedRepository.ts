import { Schema } from "effect"

export class FollowedRepository extends Schema.Class<FollowedRepository>("FollowedRepository")({
  owner: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/)),
  repo: Schema.String.check(Schema.isPattern(/^(?!\.{1,2}$)[a-z0-9_.-]{1,100}$/)),
}) {}

/** Followed repositories are stored lowercase, so this identifies one exactly. */
export const repositoryKey = ({ owner, repo }: FollowedRepository) => `${owner}/${repo}`

export class InvalidRepositoryInput extends Schema.TaggedError<InvalidRepositoryInput>()(
  "InvalidRepositoryInput",
  { input: Schema.String },
) {}
