import { ConversationError, RPC_PATH } from "@glass/contracts"
import type { AgentHarness, SandboxProvider, SandboxState, SandboxTarget } from "@glass/plugin"
import { DateTime, Duration, Effect, Schedule } from "effect"
import { AgentHostRpcs, HEALTH_PATH, HOST_TOKEN_HEADER, SHUTDOWN_PATH } from "./agentHost/protocol"
import { connectRpcClient } from "./rpcSocket"
import { MissingLogin, NoCapacity, SandboxGone } from "./sandboxFailures"

export const SANDBOX_DEADLINES = {
  startHost: Duration.minutes(1),
  connect: Duration.seconds(30),
  endHost: Duration.seconds(10),
  remove: Duration.minutes(2),
  extend: Duration.seconds(30),
  models: Duration.seconds(30),
}

const abortThenAwaitProvider = (controller: AbortController, running: Promise<unknown>) =>
  Effect.promise(() => {
    controller.abort()

    return running.then(
      () => undefined,
      () => undefined,
    )
  }).pipe(Effect.timeout("10 seconds"), Effect.ignore)

const fromProvider = <A>(run: (signal: AbortSignal) => Promise<A>, onCancel: "await" | "abandon") =>
  Effect.callback<A, { readonly rejected: unknown }>((resume) => {
    const controller = new AbortController()
    const running = Promise.resolve().then(() => run(controller.signal))

    running.then(
      (value) => resume(Effect.succeed(value)),
      (rejected) => resume(Effect.fail({ rejected })),
    )

    return onCancel === "await"
      ? abortThenAwaitProvider(controller, running)
      : Effect.sync(() => controller.abort())
  })

const providerFailure =
  (provider: SandboxProvider, action: string) =>
  ({ rejected }: { readonly rejected: unknown }) => {
    if (rejected instanceof MissingLogin)
      return Effect.fail(
        new ConversationError({
          message: `${provider.name} needs your ${rejected.login} login. Run ${rejected.fix}, then try again.`,
        }),
      )

    if (rejected instanceof NoCapacity)
      return Effect.fail(
        new ConversationError({ message: `${rejected.message} Try again in a little while.` }),
      )

    return Effect.logWarning(`${provider.name} couldn't ${action}`, rejected).pipe(
      Effect.andThen(
        Effect.fail(
          new ConversationError({
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
                new ConversationError({
                  message: `${provider.name} didn't answer in time, so Glass couldn't ${action}. Try again.`,
                }),
              ),
            ),
          ),
      }),
    )

export const createSandbox = (
  provider: SandboxProvider,
  create: (signal: AbortSignal) => Promise<void>,
) =>
  fromProvider(create, "await").pipe(Effect.catch(providerFailure(provider, "create the Sandbox")))

export const listModels = (provider: SandboxProvider, harness: AgentHarness) =>
  fromProvider((signal) => provider.models(harness, signal), "abandon").pipe(
    Effect.catch(providerFailure(provider, "list what its Sandboxes offer")),
    boundSandboxCall(provider, "list what its Sandboxes offer", SANDBOX_DEADLINES.models),
  )

const hostUrl = (target: SandboxTarget, path: string) => {
  const url = new URL(target.url)
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`

  return url
}

const callAbout = <A>(
  provider: SandboxProvider,
  action: string,
  run: (signal: AbortSignal) => Promise<A>,
) =>
  fromProvider(run, "abandon").pipe(
    Effect.catch(({ rejected }): Effect.Effect<never, ConversationError | SandboxGone> =>
      rejected instanceof SandboxGone
        ? Effect.fail(rejected)
        : providerFailure(provider, action)({ rejected }),
    ),
  )

const targetOf = (provider: SandboxProvider, state: SandboxState) =>
  callAbout(provider, "reach the Sandbox", (signal) => provider.target(state, signal))

export const removeSandbox = (provider: SandboxProvider, state: SandboxState, action: string) =>
  callAbout(provider, action, (signal) => provider.remove(state, signal)).pipe(
    Effect.catchTag("SandboxGone", () => Effect.void),
    boundSandboxCall(provider, action, SANDBOX_DEADLINES.remove),
  )

export const extendSandbox = (
  provider: SandboxProvider,
  extend: NonNullable<SandboxProvider["extend"]>,
  state: SandboxState,
) =>
  callAbout(provider, "extend the Sandbox", (signal) => extend(state, signal)).pipe(
    boundSandboxCall(provider, "extend the Sandbox", SANDBOX_DEADLINES.extend),
    Effect.flatMap((date) =>
      Effect.fromOption(DateTime.make(date)).pipe(
        Effect.mapError(
          () =>
            new ConversationError({
              message: `${provider.name} answered an expiry Glass can't read.`,
            }),
        ),
      ),
    ),
  )

const didntStart = () =>
  new ConversationError({ message: "The agent in the Sandbox didn't start. Try again." })

export const waitForHost = (provider: SandboxProvider, state: SandboxState) =>
  targetOf(provider, state).pipe(
    Effect.catchTag("SandboxGone", () => Effect.fail(didntStart())),
    Effect.flatMap((target) =>
      Effect.tryPromise((signal) =>
        fetch(hostUrl(target, HEALTH_PATH), { headers: { ...target.headers }, signal }),
      ).pipe(
        Effect.filterOrFail((response) => response.ok),
        Effect.retry({ schedule: Schedule.spaced("250 millis") }),
      ),
    ),
    Effect.timeoutOrElse({
      duration: SANDBOX_DEADLINES.startHost,
      orElse: () => Effect.fail(didntStart()),
    }),
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
    boundSandboxCall(provider, "reach the Sandbox", SANDBOX_DEADLINES.connect),
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
      ).pipe(Effect.filterOrFail((response) => response.ok)),
    ),
    Effect.timeout(SANDBOX_DEADLINES.endHost),
    Effect.tapError((cause) =>
      Effect.logWarning(`Couldn't end the agent host in a Sandbox of ${provider.name}`, cause),
    ),
    Effect.ignore,
  )
