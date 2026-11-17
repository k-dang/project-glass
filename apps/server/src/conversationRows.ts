import {
  Conversation,
  type ConversationPlace,
  type ConversationSkillPack,
  FollowedRepository,
  SandboxPlace,
  localPlace,
} from "@glass/contracts"
import { Predicate, Schema } from "effect"
import type { PlacedConversation } from "./Placement"

const StoredConversation = Schema.Struct({
  id: Conversation.fields.id,
  name: Conversation.fields.name,
  sandboxProvider: Schema.NullOr(Schema.String),
  owner: FollowedRepository.fields.owner,
  repo: FollowedRepository.fields.repo,
  baseBranch: Conversation.fields.baseBranch,
  branch: Conversation.fields.branch,
  harness: Conversation.fields.harness,
  model: Conversation.fields.model,
  effort: Conversation.fields.effort,
  permissionMode: Conversation.fields.permissionMode,
  localSkills: Schema.BooleanFromBit,
  folder: Schema.String,
  createdAt: Conversation.fields.createdAt,
  forReview: Schema.BooleanFromBit,
})

export const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredConversation))

export const toRow = (
  {
    owner,
    repo,
    folder,
    sandboxProvider,
    forReview,
    ...conversation
  }: typeof StoredConversation.Type,
  skillPacks: ReadonlyArray<ConversationSkillPack>,
): PlacedConversation => ({
  conversation: new Conversation({
    ...conversation,
    forReview,
    skillPacks,
    place:
      sandboxProvider === null ? localPlace : SandboxPlace.make({ providerId: sandboxProvider }),
    repository: new FollowedRepository({ owner, repo }),
    sandbox: null,
  }),
  folder,
  forReview,
})

export const conversationWith = (
  conversation: Conversation,
  change: Partial<typeof Conversation.Type>,
) =>
  // oxlint-disable-next-line typescript/no-misused-spread -- The fields go straight back into Conversation.
  new Conversation({ ...conversation, ...change })

export const sandboxProviderOf = (place: ConversationPlace) =>
  Predicate.isTagged(place, "sandbox") ? place.providerId : null
