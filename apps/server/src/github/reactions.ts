import { Reaction, ReactionGroup } from "@glass/contracts"
import { Schema } from "effect"

export const REACTION_GROUPS = "reactionGroups { content reactors { totalCount } viewerHasReacted }"

export const reactionContents = {
  "thumbs-up": "THUMBS_UP",
  "thumbs-down": "THUMBS_DOWN",
  laugh: "LAUGH",
  hooray: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
  eyes: "EYES",
} as const satisfies Record<Reaction, string>

const reactions = new Map<string, Reaction>(
  Reaction.literals.map((reaction) => [reactionContents[reaction], reaction]),
)

export const GitHubReactionGroups = Schema.Array(
  Schema.Struct({
    content: Schema.String,
    reactors: Schema.Struct({ totalCount: Schema.Int }),
    viewerHasReacted: Schema.Boolean,
  }),
)

export const toReactionGroups = (groups: typeof GitHubReactionGroups.Type) =>
  groups.flatMap(({ content, reactors, viewerHasReacted }) => {
    // Skips contents GitHub added after this mapping, so they can't fail the whole workspace.
    const reaction = reactions.get(content)

    return reaction === undefined || reactors.totalCount === 0
      ? []
      : [new ReactionGroup({ reaction, count: reactors.totalCount, reacted: viewerHasReacted })]
  })

export const reactionMutation = (reacted: boolean) => {
  const [name, field] = reacted
    ? (["AddReaction", "addReaction"] as const)
    : (["RemoveReaction", "removeReaction"] as const)

  return {
    name,
    field,
    query: `mutation ${name}($subjectId: ID!, $content: ReactionContent!) {
  ${field}(input: { subjectId: $subjectId, content: $content }) { subject { ${REACTION_GROUPS} } }
}`,
  }
}

const ChangedSubject = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      subject: Schema.NullOr(
        Schema.Struct({ reactionGroups: Schema.NullOr(GitHubReactionGroups) }),
      ),
    }),
  ),
)

export const ReactionMutationPayload = Schema.Struct({
  addReaction: ChangedSubject,
  removeReaction: ChangedSubject,
})
