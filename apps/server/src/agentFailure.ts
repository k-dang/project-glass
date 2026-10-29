import { AgentRunnerIdentity } from "@glass/contracts"
import { Schema } from "effect"

export class AgentFailure extends Schema.TaggedError<AgentFailure>()("AgentFailure", {
  reason: Schema.Literals([
    "not-installed",
    "not-ready",
    "authentication",
    "unusable-output",
    "storage",
    "failed",
  ]),
  message: Schema.String,
  runner: Schema.NullOr(AgentRunnerIdentity),
}) {}

export const agentFailure = (
  reason: AgentFailure["reason"],
  message: string,
  runner: AgentRunnerIdentity | null = null,
) => new AgentFailure({ reason, message, runner })

export const saysSignInFailed = (said: string) =>
  /not (?:signed|logged) in|unauthorized|authentication|invalid.*(?:token|key)|401|no api key/i.test(
    said,
  )

export const runnerFailureReason = (output: string) =>
  saysSignInFailed(output) ? "authentication" : "failed"
