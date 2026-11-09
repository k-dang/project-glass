import {
  type AgentRunnerIdentity,
  type CheckoutRunReason,
  type ConnectionError,
  type EngineFeature,
  type NoCredentials,
  type PullRequestRef,
  type Revision,
  type StaleRevision,
} from "@glass/contracts"
import {
  Context,
  Data,
  type Duration,
  Effect,
  Layer,
  Predicate,
  type Schema,
  type Scope,
} from "effect"
import type { AgentFailure } from "./agentFailure"
import type { AgentTools } from "./agentTools"
import { AgentRunners } from "./agentRunners"
import { type CheckoutFailure, Checkouts } from "./Checkouts"
import { engineSettingsOf, SettingsStore } from "./SettingsStore"
import { annotateUnit, recordDuration } from "./wideEvents"

export class CheckoutRunFailure extends Data.TaggedError("CheckoutRunFailure")<{
  readonly reason: CheckoutRunReason
  readonly message: string
  readonly runner: AgentRunnerIdentity | null
}> {}

export const checkoutRunFailure = (
  reason: CheckoutRunReason,
  message: string,
  runner: AgentRunnerIdentity | null = null,
) => new CheckoutRunFailure({ reason, message, runner })

const agentFailureReasons: Record<AgentFailure["reason"], CheckoutRunReason> = {
  "not-installed": "not-ready",
  "not-ready": "not-ready",
  authentication: "runner",
  failed: "runner",
  "unusable-output": "unusable-output",
  storage: "storage",
}

const checkoutMessages: Record<CheckoutFailure["reason"], readonly [CheckoutRunReason, string]> = {
  "access-refused": [
    "no-access",
    "Your GitHub Connection can't read this repository's code. Check its access, then try again.",
  ],
  unreachable: [
    "fetch-failed",
    "Couldn't reach the repository to fetch the PR's code. Check your connection, then try again.",
  ],
  "fetch-failed": [
    "fetch-failed",
    "Fetching the PR's code failed. Git's output is in Glass's backend log; try again.",
  ],
  timeout: ["fetch-failed", "Fetching the PR's code took too long. Try again."],
  storage: [
    "storage",
    "Couldn't prepare a copy of the PR's code. Check that your disk has free space, then try again.",
  ],
}

const staleFailure = (identity: AgentRunnerIdentity | null) =>
  checkoutRunFailure(
    "stale-revision",
    "The PR has new commits since Glass loaded it. Reload, then try again.",
    identity,
  )

const fromAgentFailure = ({ reason, message, runner }: AgentFailure) =>
  checkoutRunFailure(agentFailureReasons[reason], message, runner)

export interface CheckoutTask<A> {
  readonly instructions: string
  readonly prompt: string
  readonly answer: Schema.Decoder<A>
  readonly tools: AgentTools
}

export interface CheckoutRun<I, A> {
  readonly pr: PullRequestRef
  readonly revision: Revision
  readonly subject: string
  readonly timeout: Duration.Input
  readonly read: (
    pr: PullRequestRef,
    revision: Revision,
  ) => Effect.Effect<I, StaleRevision | ConnectionError>
  readonly task: (input: I) => Effect.Effect<CheckoutTask<A>, CheckoutRunFailure>
}

export interface CheckoutAnswer<I, A> {
  readonly input: I
  readonly answer: A
}

export interface CheckoutCopy<I> {
  readonly pr: PullRequestRef
  readonly revision: Revision
  readonly subject: string
  readonly folder: string
  readonly read: CheckoutRun<I, unknown>["read"]
}

export interface CheckoutRunner {
  readonly identity: AgentRunnerIdentity
  readonly run: <I, A>(
    run: CheckoutRun<I, A>,
  ) => Effect.Effect<CheckoutAnswer<I, A>, CheckoutRunFailure>
}

const readMaterial = <I>(
  {
    pr,
    revision,
    subject,
    read,
  }: Pick<CheckoutRun<I, unknown>, "pr" | "revision" | "subject" | "read">,
  identity: AgentRunnerIdentity | null,
) =>
  read(pr, revision).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning(`Couldn't read the Revision for the ${subject}`, cause),
    ),
    Effect.mapError((error) =>
      Predicate.isTagged(error, "StaleRevision")
        ? staleFailure(identity)
        : checkoutRunFailure(
            "github",
            "Couldn't read the PR from GitHub. Check your connection, then try again.",
            identity,
          ),
    ),
  )

const checkoutError =
  (identity: AgentRunnerIdentity | null) =>
  (error: CheckoutFailure | StaleRevision | NoCredentials) => {
    if (Predicate.isTagged(error, "StaleRevision")) return staleFailure(identity)

    if (Predicate.isTagged(error, "NoCredentials"))
      return checkoutRunFailure(
        "no-access",
        "Glass isn't signed in to GitHub, so it can't fetch the PR's code.",
        identity,
      )

    const [reason, message] = checkoutMessages[error.reason]

    return checkoutRunFailure(reason, message, identity)
  }

export class CheckoutRuns extends Context.Service<
  CheckoutRuns,
  {
    readonly select: (
      feature: EngineFeature,
    ) => Effect.Effect<CheckoutRunner, CheckoutRunFailure, Scope.Scope>
    readonly copy: <I>(copy: CheckoutCopy<I>) => Effect.Effect<I, CheckoutRunFailure>
  }
>()("@glass/server/CheckoutRuns") {
  static readonly layer = Layer.effect(
    CheckoutRuns,
    Effect.gen(function* () {
      const checkouts = yield* Checkouts
      const runners = yield* AgentRunners
      const settings = yield* SettingsStore

      const copy = Effect.fnUntraced(function* <I>(options: CheckoutCopy<I>) {
        yield* annotateUnit({ head: options.revision.head })

        const [input] = yield* Effect.all(
          [
            readMaterial(options, null),
            checkouts
              .checkoutInto(options.pr, options.revision, options.folder)
              .pipe(Effect.mapError(checkoutError(null))),
          ],
          { concurrency: 2 },
        )

        return input
      })

      const select = Effect.fnUntraced(function* (feature: EngineFeature) {
        const engineSettings = yield* settings.read().pipe(
          Effect.map((current) => engineSettingsOf(current, feature)),
          Effect.mapError((error) => checkoutRunFailure("not-ready", error.message)),
        )

        const selected = yield* runners
          .select(engineSettings)
          .pipe(Effect.mapError(fromAgentFailure))

        const { identity } = selected

        const run = Effect.fnUntraced(function* <I, A>({
          pr,
          revision,
          subject,
          timeout,
          read,
          task,
        }: CheckoutRun<I, A>) {
          const prepare = readMaterial({ pr, revision, subject, read }, identity).pipe(
            Effect.flatMap((input) =>
              task(input).pipe(Effect.map((prepared) => ({ input, prepared }))),
            ),
          )

          const checkOut = checkouts
            .checkout(pr, revision)
            .pipe(Effect.mapError(checkoutError(identity)), recordDuration("checkout_ms"))

          yield* annotateUnit({
            engine: identity.engine,
            model: identity.model,
            head: revision.head,
          })

          const [{ input, prepared }, checkout] = yield* Effect.all([prepare, checkOut], {
            concurrency: 2,
          })

          return yield* selected.run({ ...prepared, subject, checkout }).pipe(
            recordDuration("agent_ms"),
            Effect.map((answer) => ({ input, answer })),
            Effect.mapError(fromAgentFailure),
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  checkoutRunFailure(
                    "timeout",
                    `The agent took too long writing the ${subject}. Try again.`,
                    identity,
                  ),
                ),
            }),
          )
        }, Effect.scoped)

        return { identity, run } satisfies CheckoutRunner
      })

      return CheckoutRuns.of({ select, copy })
    }),
  )
}
