import { AgentError, RPC_PATH } from "@glass/contracts"
import { Effect, Schedule } from "effect"
import { AgentHostRpcs, HEALTH_PATH, HOST_TOKEN_HEADER } from "./agentHost/protocol"
import { connectRpcClient } from "./rpcSocket"
import {
  MissingLogin,
  NoCapacity,
  type SandboxProvider,
  type SandboxState,
  type SandboxTarget,
} from "./SandboxProvider"

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

const targetOf = (provider: SandboxProvider, state: SandboxState) =>
  call(provider, "reach the Sandbox", () => provider.target(state))

export const waitForHost = (provider: SandboxProvider, state: SandboxState) =>
  targetOf(provider, state).pipe(
    Effect.flatMap((target) =>
      Effect.tryPromise(() =>
        fetch(hostUrl(target, HEALTH_PATH), { headers: { ...target.headers } }),
      ).pipe(
        Effect.filterOrFail((response) => response.ok),
        Effect.retry({ schedule: Schedule.spaced("250 millis") }),
        Effect.timeout("1 minute"),
        Effect.mapError(
          () => new AgentError({ message: "The agent in the Sandbox didn't start. Try again." }),
        ),
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
