import type { AgentEngine, AgentModels } from "@glass/contracts"
import type { Json } from "effect/Schema"

/** What a Plugin adds to Glass: a kind of Sandbox to start Agents in (ADR 0008). */
export interface SandboxProvider {
  /** What the user sees for this kind of Sandbox, a plural such as "Acme Sandboxes". */
  readonly name: string
  /**
   * Makes the Sandbox, sets up the user's logins, clones the repository onto the Agent's branch,
   * and starts the agent host in it. Calls `record` as soon as the Sandbox exists, so Glass can
   * delete a half-built one, and `progress` for each step the user should see. Glass waits for
   * the host's health check once this resolves.
   */
  readonly create: (request: SandboxRequest, context: SandboxCreation) => Promise<void>
  /** Where the agent host in the Sandbox answers, asked afresh for each connection. */
  readonly target: (state: SandboxState) => Promise<SandboxTarget>
  readonly remove: (state: SandboxState) => Promise<void>
  /** What an Agent program offers in this provider's Sandboxes, before one exists. */
  readonly models: (engine: AgentEngine) => Promise<AgentModels>
}

/**
 * Whatever a provider recorded about one Sandbox. Glass keeps it on the Agent and hands it back;
 * providers must read state their earlier versions wrote.
 */
export type SandboxState = Json

export interface SandboxRequest {
  readonly agentId: string
  readonly engine: AgentEngine
  readonly repository: { readonly owner: string; readonly repo: string }
  /** The Agent's own branch, made from `baseBranch`. */
  readonly branch: string
  /** The clone's `origin` remote must have it, as Review changes diffs against it. */
  readonly baseBranch: string
  /** Where the clone goes, relative to the folder the host is started in. */
  readonly folder: string
  readonly host: SandboxHost
}

export interface SandboxHost {
  /** The host's bundle on this Mac, for the provider to copy into the Sandbox and run with Node. */
  readonly bundle: string
  /** The port the host listens on in the Sandbox, which `target` reaches. */
  readonly port: number
  /** The environment to start the host with, including its port and address. */
  readonly environment: Readonly<Record<string, string>>
}

export interface SandboxCreation {
  readonly progress: (step: string) => void
  readonly record: (state: SandboxState) => void
  /** Aborted when the user cancels or Glass shuts down part-way. */
  readonly signal: AbortSignal
}

export interface SandboxTarget {
  /** The host's HTTP(S) base URL; Glass adds the paths it calls. */
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/** A login the Sandbox needs that the user doesn't have, with the command that fixes it. */
export class MissingLogin extends Error {
  constructor(
    readonly login: string,
    readonly fix: string,
  ) {
    super(`Missing login: ${login}. Run \`${fix}\`.`)
    this.name = "MissingLogin"
  }
}

/** The platform has no room for another Sandbox right now; trying again later may work. */
export class NoCapacity extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NoCapacity"
  }
}

export interface Glass {
  /** `id` is lowercase letters, digits, and dashes, starting with a letter or digit. */
  readonly registerSandboxProvider: (id: string, provider: SandboxProvider) => void
  readonly missingLogin: (login: string, fix: string) => MissingLogin
  readonly noCapacity: (message: string) => NoCapacity
}

export type Plugin = (glass: Glass) => void | Promise<void>
