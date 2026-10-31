import { Agent, FollowedRepository, thisMac } from "@glass/contracts"
import { DateTime } from "effect"

export const agentFields = {
  id: "agent-1",
  name: "agent/swift-otter",
  place: thisMac,
  repository: new FollowedRepository({ owner: "glass-demo", repo: "greeter" }),
  baseBranch: "main",
  engine: "pi",
  model: null,
  effort: null,
  permissionMode: null,
  createdAt: DateTime.makeUnsafe("2026-10-26T12:00:00Z"),
} as const

export const agent = new Agent(agentFields)
