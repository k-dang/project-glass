/** What a Plugin adds to Glass: a kind of Sandbox to start Threads in. */
export interface SandboxProvider {
  /** What the user sees for this kind of Sandbox, a plural such as "Acme Sandboxes". */
  readonly name: string
  /**
   * The Agent harnesses its Sandboxes can run. Glass offers only these for this kind of Sandbox, and
   * asks `create` and `models` about no other.
   */
  readonly harnesses: readonly [AgentHarness, ...Array<AgentHarness>]
  /**
   * Makes the Sandbox, sets up the user's logins, and clones the repository onto the Thread's
   * branch. Calls `record` as soon as the Sandbox exists, so Glass can delete a half-built one, and
   * `progress` for each step the user should see. Glass calls `startHost` once this resolves.
   */
  readonly create: (request: SandboxRequest, context: SandboxCreation) => Promise<void>
  /**
   * Copies the agent host's bundle into the Sandbox and starts it there. Glass calls it for a new
   * Sandbox, and again when the host that answers is from another version of Glass. Glass has asked
   * that host to end first; one it couldn't reach may still run, so this ends it before starting
   * the new one. Glass waits for the host's health check once this resolves. Throws
   * `glass.sandboxGone()` once the Sandbox no longer exists.
   */
  readonly startHost: (state: SandboxState, host: SandboxHost, signal: AbortSignal) => Promise<void>
  /**
   * Where the agent host in the Sandbox answers, asked afresh for each connection. Throws
   * `glass.sandboxGone()` once the Sandbox no longer exists, so Glass stops trying to reach it.
   */
  readonly target: (state: SandboxState, signal: AbortSignal) => Promise<SandboxTarget>
  /**
   * Pushes the Sandbox's expiry as late as the platform allows, answering when it now expires.
   * Glass calls it while the Thread exists and Glass runs, again before each expiry it was given,
   * until the expiry stops moving. Throws `glass.sandboxGone()` once the Sandbox no longer exists.
   * A provider whose Sandboxes don't expire leaves it out.
   */
  readonly extend?: (state: SandboxState, signal: AbortSignal) => Promise<Date>
  /**
   * Deletes the Sandbox. Glass has asked its agent host to end first; one it couldn't reach may
   * still run. Throws `glass.sandboxGone()` if the Sandbox is already gone, which Glass takes as
   * done.
   */
  readonly remove: (state: SandboxState, signal: AbortSignal) => Promise<void>
  /** What an Agent harness offers in this provider's Sandboxes, before one exists. */
  readonly models: (harness: AgentHarness, signal: AbortSignal) => Promise<AgentModels>
}

export const agentHarnesses = ["claude-code", "pi"] as const

export type AgentHarness = (typeof agentHarnesses)[number]

/** A model an Agent harness offers, with the efforts it takes, from lowest to highest. */
export interface AgentModel {
  readonly id: string
  readonly name: string
  readonly efforts: ReadonlyArray<string>
}

export interface AgentModels {
  /** What a `null` model runs: the harness's own default, if it has one. */
  readonly defaultModel: AgentModel | null
  readonly models: ReadonlyArray<AgentModel>
}

export type Json = null | number | boolean | string | ReadonlyArray<Json> | JsonObject

export interface JsonObject {
  readonly [key: string]: Json
}

/**
 * Whatever a provider recorded about one Sandbox. Glass keeps it on the Thread and hands it back;
 * providers must read state their earlier versions wrote.
 */
export type SandboxState = Json

export interface SandboxRequest {
  readonly threadId: string
  readonly harness: AgentHarness
  readonly repository: { readonly owner: string; readonly repo: string }
  /** The Thread's own branch, made from `baseBranch`. Glass may rename it once the host starts. */
  readonly branch: string
  /** The clone's `origin` remote must have it, as Review changes diffs against it. */
  readonly baseBranch: string
  /** Where the clone goes, relative to the folder the host is started in. */
  readonly folder: string
  /** The port the host will listen on in the Sandbox, which `target` reaches. */
  readonly hostPort: number
}

export interface SandboxHost {
  /** The host's bundle on this device, one self-contained file for the provider to copy into the Sandbox and run with Node. */
  readonly bundle: string
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
  /** The Sandbox no longer exists, with everything in it, so its Thread can only be removed. */
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
 * the cause in the backend log. If making a Sandbox fails or is cancelled after `record`, Glass
 * calls `remove` with that state.
 *
 * Glass gives every call but `create` a deadline and aborts its `signal` once that passes, then
 * stops waiting for it. Glass retries what it still needs, such as `startHost`, `remove`, and
 * `extend`, so those must be safe to call again while an earlier call may still run.
 */
export type Plugin = (glass: Glass) => void | Promise<void>
