import {
  Thread,
  type ThreadPlace,
  type ThreadSkillPack,
  FollowedRepository,
  SandboxPlace,
  localPlace,
} from "@glass/contracts"
import { Predicate, Schema } from "effect"
import type { PlacedThread } from "./Placement"

const StoredThread = Schema.Struct({
  id: Thread.fields.id,
  name: Thread.fields.name,
  sandboxProvider: Schema.NullOr(Schema.String),
  owner: FollowedRepository.fields.owner,
  repo: FollowedRepository.fields.repo,
  baseBranch: Thread.fields.baseBranch,
  branch: Thread.fields.branch,
  harness: Thread.fields.harness,
  model: Thread.fields.model,
  effort: Thread.fields.effort,
  permissionMode: Thread.fields.permissionMode,
  localSkills: Schema.BooleanFromBit,
  folder: Schema.String,
  createdAt: Thread.fields.createdAt,
  forReview: Schema.BooleanFromBit,
})

export const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredThread))

export const toRow = (
  { owner, repo, folder, sandboxProvider, forReview, ...thread }: typeof StoredThread.Type,
  skillPacks: ReadonlyArray<ThreadSkillPack>,
): PlacedThread => ({
  thread: new Thread({
    ...thread,
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

export const threadWith = (thread: Thread, change: Partial<typeof Thread.Type>) =>
  // oxlint-disable-next-line typescript/no-misused-spread -- The fields go straight back into Thread.
  new Thread({ ...thread, ...change })

export const sandboxProviderOf = (place: ThreadPlace) =>
  Predicate.isTagged(place, "sandbox") ? place.providerId : null
