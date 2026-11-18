import { Conversation, FollowedRepository, localPlace } from "@glass/contracts"
import { DateTime } from "effect"

export const conversationFields = {
  id: "agent-1",
  name: "agent/swift-otter",
  place: localPlace,
  repository: new FollowedRepository({ owner: "glass-demo", repo: "greeter" }),
  baseBranch: "main",
  branch: "agent/swift-otter",
  harness: "pi",
  model: null,
  effort: null,
  permissionMode: null,
  skillPacks: [],
  localSkills: false,
  createdAt: DateTime.makeUnsafe("2026-10-26T12:00:00Z"),
  sandbox: null,
} as const

export const conversation = new Conversation(conversationFields)
