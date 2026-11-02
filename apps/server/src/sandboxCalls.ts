import { AgentError, RPC_PATH } from "@glass/contracts"
import type { SandboxProvider, SandboxState, SandboxTarget } from "@glass/plugin"
import { DateTime, Effect, Schedule } from "effect"
import { AgentHostRpcs, HEALTH_PATH, HOST_TOKEN_HEADER, SHUTDOWN_PATH } from "./agentHost/protocol"
import { connectRpcClient } from "./rpcSocket"
import { MissingLogin, NoCapacity, SandboxGone } from "./sandboxFailures"

const abortThenAwaitProvider = (controller: AbortController, running: Promise<unknown>) =>
  Effect.promise(() => {
    controller.abort()

    return running.then(
      () => undefined,
      () => undefined,
    )
  }).pipe(Effect.timeout("10 seconds"), Effect.ignore)

const fromProvider = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.callback<A, { readonly rejected: unknown }>((resume) => {
    const controller = new AbortController()
    const running = Promise.resolve().then(() => run(controller.signal))

    running.then(
      (value) => resume(Effect.succeed(value)),
      (rejected) => resume(Effect.fail({ rejected })),
    )

    return abortThenAwaitProvider(controller, running)
  })

const providerFailure =
  (provider: SandboxProvider, action: string) =>
  ({ rejected }: { readonly rejected: unknown }) => {
    if (rejected instanceof MissingLogin)
      return Effect.fail(
        new AgentError({
          message: `${provider.name} needs your ${rejected.login} login. Run ${rejected.fix}, then try again.`,
        }),
      )

    if (rejected instanceof NoCapacity)
      return Effect.fail(
        new AgentError({ message: `${rejected.message} Try again in a little while.` }),
      )

    return Effect.logWarning(`${provider.name} couldn't ${action}`, rejected).pipe(
      Effect.andThen(
        Effect.fail(
          new AgentError({
            message: `Couldn't ${action}. Try again; Glass's backend log has the details.`,
          }),
        ),
      ),
    )
  }

export const call = <A>(
  provider: SandboxProvider,
  action: string,
  run: (signal: AbortSignal) => Promise<A>,
) => fromProvider(run).pipe(Effect.catch(providerFailure(provider, action)))

const hostUrl = (target: SandboxTarget, path: string) => {
  const url = new URL(target.url)
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`

  return url
}

/** A call about a Sandbox that may be gone, which the provider says by throwing `SandboxGone`. */
const callAbout = <A>(provider: SandboxProvider, action: string, run: () => Promise<A>) =>
  fromProvider(run).pipe(
    Effect.catch(({ rejected }): Effect.Effect<never, AgentError | SandboxGone> =>
      rejected instanceof SandboxGone
        ? Effect.fail(rejected)
        : providerFailure(provider, action)({ rejected }),
    ),
  )

const targetOf = (provider: SandboxProvider, state: SandboxState) =>
  callAbout(provider, "reach the Sandbox", () => provider.target(state))

/** Deletes the Sandbox; one already gone needs nothing more. */
export const removeSandbox = (provider: SandboxProvider, state: SandboxState, action: string) =>
  callAbout(provider, action, () => provider.remove(state)).pipe(
    Effect.catchTag("SandboxGone", () => Effect.void),
  )

export const extendSandbox = (
  provider: SandboxProvider,
  extend: (state: SandboxState) => Promise<Date>,
  state: SandboxState,
) =>
  callAbout(provider, "extend the Sandbox", () => extend(state)).pipe(
    Effect.flatMap((date) =>
      Effect.try({
        try: () => DateTime.fromDateUnsafe(date),
        catch: () =>
          new AgentError({ message: `${provider.name} answered an expiry Glass can't read.` }),
      }),
    ),
  )

const didntStart = () =>
  new AgentError({ message: "The agent in the Sandbox didn't start. Try again." })

// A Sandbox gone while being made is one Glass discards and makes again, not one left to remove.
export const waitForHost = (provider: SandboxProvider, state: SandboxState) =>
  targetOf(provider, state).pipe(
    Effect.catchTag("SandboxGone", () => Effect.fail(didntStart())),
    Effect.flatMap((target) =>
      Effect.tryPromise(() =>
        fetch(hostUrl(target, HEALTH_PATH), { headers: { ...target.headers } }),
      ).pipe(
        Effect.filterOrFail((response) => response.ok),
        Effect.retry({ schedule: Schedule.spaced("250 millis") }),
        Effect.timeout("1 minute"),
        Effect.mapError(didntStart),
      ),
    ),
  )

export const connectToHost = (provider: SandboxProvider, state: SandboxState, token: string) =>
  targetOf(provider, state).pipe(
    Effect.flatMap((target) => {
      const url = hostUrl(target, RPC_PATH)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"

      return connectRpcClient(AgentHostRpcs, String(url), {
        ...target.headers,
        [HOST_TOKEN_HEADER]: token,
      })
    }),
  )

export const shutDownHost = (provider: SandboxProvider, state: SandboxState, token: string) =>
  targetOf(provider, state).pipe(
    Effect.flatMap((target) =>
      Effect.tryPromise((signal) =>
        fetch(hostUrl(target, SHUTDOWN_PATH), {
          method: "POST",
          headers: { ...target.headers, [HOST_TOKEN_HEADER]: token },
          signal,
        }),
      ).pipe(
        Effect.filterOrFail((response) => response.ok),
        Effect.timeout("10 seconds"),
        Effect.tapError((cause) =>
          Effect.logWarning(`Couldn't end the agent host in a Sandbox of ${provider.name}`, cause),
        ),
      ),
    ),
    Effect.ignore,
  )
