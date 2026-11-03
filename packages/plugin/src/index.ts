/** What a Plugin adds to Glass: a kind of Sandbox to start Agents in (ADR 0010). */
export interface SandboxProvider {
  /** What the user sees for this kind of Sandbox, a plural such as "Acme Sandboxes". */
  readonly name: string
  /**
   * The Agent programs its Sandboxes can run. Glass offers only these for this kind of Sandbox, and
   * asks `create` and `models` about no other.
   */
  readonly engines: readonly [AgentEngine, ...Array<AgentEngine>]
  /**
   * Makes the Sandbox, sets up the user's logins, clones the repository onto the Agent's branch,
   * and starts the agent host in it. Calls `record` as soon as the Sandbox exists, so Glass can
   * delete a half-built one, and `progress` for each step the user should see. Glass waits for
   * the host's health check once this resolves.
   */
  readonly create: (request: SandboxRequest, context: SandboxCreation) => Promise<void>
  /**
   * Where the agent host in the Sandbox answers, asked afresh for each connection. Throws
   * `glass.sandboxGone()` once the Sandbox no longer exists, so Glass stops trying to reach it.
   */
  readonly target: (state: SandboxState) => Promise<SandboxTarget>
  /**
   * Pushes the Sandbox's expiry as late as the platform allows, answering when it now expires.
   * Glass calls it while the Agent exists and Glass runs, again before each expiry it was given,
   * until the expiry stops moving. Throws `glass.sandboxGone()` once the Sandbox no longer exists.
   * A provider whose Sandboxes don't expire leaves it out.
   */
  readonly extend?: (state: SandboxState) => Promise<Date>
  /**
   * Deletes the Sandbox. Glass has asked its agent host to end first; one it couldn't reach may
   * still run. Throws `glass.sandboxGone()` if the Sandbox is already gone, which Glass takes as
   * done.
   */
  readonly remove: (state: SandboxState) => Promise<void>
  /** What an Agent program offers in this provider's Sandboxes, before one exists. */
  readonly models: (engine: AgentEngine) => Promise<AgentModels>
}

/** The Agent program an Agent runs: Claude Code or pi. */
export const agentEngines = ["claude-code", "pi"] as const

export type AgentEngine = (typeof agentEngines)[number]

/** A model an Agent program offers, with the efforts it takes, from lowest to highest. */
export interface AgentModel {
  readonly id: string
  readonly name: string
  readonly efforts: ReadonlyArray<string>
}

export interface AgentModels {
  /** What a `null` model runs: the program's own default, if it has one. */
  readonly defaultModel: AgentModel | null
  readonly models: ReadonlyArray<AgentModel>
}

export type Json = null | number | boolean | string | ReadonlyArray<Json> | JsonObject

export interface JsonObject {
  readonly [key: string]: Json
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
  /** The host's bundle on this device, one self-contained file for the provider to copy into the Sandbox and run with Node. */
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

export interface Glass {
  /** `id` is lowercase letters, digits, and dashes, starting with a letter or digit. */
  readonly registerSandboxProvider: (id: string, provider: SandboxProvider) => void
  /** A login the Sandbox needs that the user doesn't have, with the command that fixes it. */
  readonly missingLogin: (login: string, fix: string) => Error
  /** The platform has no room for another Sandbox right now; trying again later may work. */
  readonly noCapacity: (message: string) => Error
  /** The Sandbox no longer exists, with everything in it, so its Agent can only be removed. */
  readonly sandboxGone: () => Error
}

/**
 * A Plugin's default export. Glass scans `~/.project-glass/plugins/*` at backend start. An entry is
 * a file, a folder with an `index.ts` or `index.js`, or a folder whose `package.json` names its
 * entry in a `"glass"` field. It may be TypeScript and bring its own `node_modules`, and runs in the
 * backend process. A Plugin that fails to load, or whose factory takes over 10 seconds, is logged
 * and skipped.
 *
 * A provider that throws anything but the errors `Glass` offers shows the user a safe failure, with
 * the cause in the backend log. If `create` fails or is cancelled after `record`, Glass calls
 * `remove` with that state.
 */
export type Plugin = (glass: Glass) => void | Promise<void>
