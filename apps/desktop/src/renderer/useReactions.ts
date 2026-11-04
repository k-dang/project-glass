import { useAtomValue } from "@effect/atom-react"
import type { Reaction, ReactionGroup } from "@glass/contracts"
import type { AtomRegistry } from "effect/reactivity"
import { Backend } from "./backend"
import { createKeyedWrites, type WriteView } from "./keyedWrites"

export interface ReactionChange {
  readonly reaction: Reaction
  readonly reacted: boolean
}

export type ReactionsView = WriteView<ReactionChange, ReadonlyArray<ReactionGroup>>

export const createReactions = (registry: AtomRegistry.AtomRegistry) =>
  createKeyedWrites(registry, (commentId, change: ReactionChange) =>
    Backend.use((backend) => backend.SetReaction({ commentId, ...change })),
  )

export type Reactions = ReturnType<typeof createReactions>

export const useReactions = (reactions: Reactions, commentId: string) =>
  useAtomValue(reactions.viewAtom(commentId))
