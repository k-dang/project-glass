import { ThreadError, RPC_PATH } from "@glass/contracts"
import type {
  AgentHarness,
  SandboxCreation,
  SandboxHost,
  SandboxProvider,
  SandboxRequest,
  SandboxState,
  SandboxTarget,
} from "@glass/plugin"
import { DateTime, Duration, Effect, Schedule } from "effect"
import { HEALTH_PATH, HOST_TOKEN_HEADER, SHUTDOWN_PATH } from "./agentHost/hostAddress"
import { AgentHostRpcs } from "./agentHost/protocol"
import { connectRpcClient } from "./rpcSocket"
import { MissingLogin, NoCapacity, SandboxGone } from "./sandboxFailures"

export const SANDBOX_DEADLINES = {
  startHost: Duration.minutes(3),
  hostAnswers: Duration.minutes(1),
  connect: Duration.seconds(30),
  endHost: Duration.seconds(10),
  remove: Duration.minutes(2),
  extend: Duration.seconds(30),
  models: Duration.seconds(30),
  settleAfterCancel: Duration.seconds(10),
}

const abortThenAwaitProvider = (controller: AbortController, running: Promise<unknown>) =>
  Effect.promise(() => {
    controller.abort()

    return running.then(
      () => undefined,
      () => undefined,
    )
  }).pipe(Effect.timeout(SANDBOX_DEADLINES.settleAfterCancel), Effect.ignore)

const runProvider = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  cancel: (controller: AbortController, running: Promise<unknown>) => Effect.Effect<void>,
) =>
  Effect.callback<A, { readonly rejected: unknown }>((resume) => {
    const controller = new AbortController()
    const running = Promise.resolve().then(() => run(controller.signal))

    running.then(
      (value) => resume(Effect.succeed(value)),
      (rejected) => resume(Effect.fail({ rejected })),
    )

    return cancel(controller, running)
  })

const fromProvider = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  runProvider(run, (controller) => Effect.sync(() => controller.abort()))

const fromProviderAwaitingCleanup = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  runProvider(run, abortThenAwaitProvider)

const providerFailure =
  (provider: SandboxProvider, action: string) =>
  ({ rejected }: { readonly rejected: unknown }) => {
    if (rejected instanceof MissingLogin)
      return Effect.fail(
        new ThreadError({
          message: `${provider.name} needs your ${rejected.login} login. Run ${rejected.fix}, then try again.`,
        }),
      )

    if (rejected instanceof NoCapacity)
      return Effect.fail(
        new ThreadError({ message: `${rejected.message} Try again in a little while.` }),
      )

    return Effect.logWarning(`${provider.name} couldn't ${action}`, rejected).pipe(
      Effect.andThen(
        Effect.fail(
          new ThreadError({
            message: `Couldn't ${action}. Try again; Glass's backend log has the details.`,
          }),
        ),
      ),
    )
  }

const boundSandboxCall =
  (provider: SandboxProvider, action: string, deadline: Duration.Duration) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () =>
          Effect.logWarning(`${provider.name} didn't answer in time to ${action}`).pipe(
            Effect.andThen(
              Effect.fail(
                new ThreadError({
                  message: `${provider.name} didn't answer in time, so Glass couldn't ${action}. Try again.`,
                }),
              ),
            ),
          ),
      }),
    )

export const createSandbox = (
  provider: SandboxProvider,
  request: SandboxRequest,
  context: Omit<SandboxCreation, "signal">,
) =>
  fromProviderAwaitingCleanup((signal) => provider.create(request, { ...context, signal })).pipe(
    Effect.catch(providerFailure(provider, "create the Sandbox")),
  )

export const listModels = (provider: SandboxProvider, harness: AgentHarness) => {
  const action = "list what its Sandboxes offer"

  return fromProvider((signal) => provider.models(harness, signal)).pipe(
    Effect.catch(providerFailure(provider, action)),
    boundSandboxCall(provider, action, SANDBOX_DEADLINES.models),
  )
}

const hostUrl = (target: SandboxTarget, path: string) => {
  const url = new URL(target.url)
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`

  return url
}

const failureAbout =
  (provider: SandboxProvider, action: string) =>
  ({ rejected }: { readonly rejected: unknown }): Effect.Effect<never, ThreadError | SandboxGone> =>
    rejected instanceof SandboxGone
      ? Effect.fail(rejected)
      : providerFailure(provider, action)({ rejected })

const callAbout = <A>(
  provider: SandboxProvider,
  action: string,
  run: (signal: AbortSignal) => Promise<A>,
) => fromProvider(run).pipe(Effect.catch(failureAbout(provider, action)))

const targetOf = (provider: SandboxProvider, state: SandboxState) =>
  callAbout(provider, "reach the Sandbox", (signal) => provider.target(state, signal))

export const extendSandbox = (
  provider: SandboxProvider,
  extend: NonNullable<SandboxProvider["extend"]>,
  state: SandboxState,
) => {
  const action = "extend the Sandbox"

  return callAbout(provider, action, (signal) => extend(state, signal)).pipe(
    boundSandboxCall(provider, action, SANDBOX_DEADLINES.extend),
    Effect.flatMap((date) =>
      Effect.fromOption(DateTime.make(date)).pipe(
        Effect.mapError(
          () =>
            new ThreadError({
              message: `${provider.name} answered an expiry Glass can't read.`,
            }),
        ),
      ),
    ),
  )
}

export const hostDidntStart = () =>
  new ThreadError({ message: "The agent in the Sandbox didn't start. Try again." })

const waitForHost = (provider: SandboxProvider, state: SandboxState) =>
  targetOf(provider, state).pipe(
    Effect.flatMap((target) =>
      Effect.tryPromise((signal) =>
        fetch(hostUrl(target, HEALTH_PATH), { headers: { ...target.headers }, signal }),
      ).pipe(
        Effect.filterOrFail((response) => response.ok),
        Effect.retry({ schedule: Schedule.spaced("250 millis") }),
        Effect.mapError(hostDidntStart),
      ),
    ),
    Effect.timeoutOrElse({
      duration: SANDBOX_DEADLINES.hostAnswers,
      orElse: () => Effect.fail(hostDidntStart()),
    }),
  )

export const startHost = (provider: SandboxProvider, state: SandboxState, host: SandboxHost) => {
  const action = "start the agent in the Sandbox"

  return fromProviderAwaitingCleanup((signal) => provider.startHost(state, host, signal)).pipe(
    Effect.catch(failureAbout(provider, action)),
    boundSandboxCall(provider, action, SANDBOX_DEADLINES.startHost),
    Effect.andThen(waitForHost(provider, state)),
  )
}

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
    Effect.timeoutOrElse({
      duration: SANDBOX_DEADLINES.connect,
      orElse: () =>
        Effect.fail(
          new ThreadError({
            message: "Glass couldn't reach the Sandbox in time. Try again.",
          }),
        ),
    }),
  )

const shutDownHost = (provider: SandboxProvider, state: SandboxState, token: string) =>
  targetOf(provider, state).pipe(
    Effect.flatMap((target) =>
      Effect.tryPromise((signal) =>
        fetch(hostUrl(target, SHUTDOWN_PATH), {
          method: "POST",
          headers: { ...target.headers, [HOST_TOKEN_HEADER]: token },
          signal,
        }),
      ).pipe(Effect.filterOrFail((response) => response.ok)),
    ),
    Effect.timeout(SANDBOX_DEADLINES.endHost),
    Effect.ignore({
      log: "Warn",
      message: `Couldn't end the agent host in a Sandbox of ${provider.name}`,
    }),
  )

export const replaceHost = (
  provider: SandboxProvider,
  { state, token }: { readonly state: SandboxState; readonly token: string },
  host: SandboxHost,
) => shutDownHost(provider, state, token).pipe(Effect.andThen(startHost(provider, state, host)))

export const deleteSandbox = (
  provider: SandboxProvider,
  { state, token }: { readonly state: SandboxState; readonly token: string },
  action: string,
) =>
  shutDownHost(provider, state, token).pipe(
    Effect.andThen(callAbout(provider, action, (signal) => provider.remove(state, signal))),
    Effect.catchTag("SandboxGone", () => Effect.void),
    boundSandboxCall(provider, action, SANDBOX_DEADLINES.remove),
  )
