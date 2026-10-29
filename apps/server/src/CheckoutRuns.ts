import {
  type AgentRunnerIdentity,
  type CheckoutRunReason,
  type ConnectionError,
  type PullRequestRef,
  readsFiles,
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
import { AgentRunners } from "./agentRunners"
import { type CheckoutFailure, Checkouts } from "./Checkouts"
import { engineSettingsOf, SettingsStore } from "./SettingsStore"

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

const fromAgentFailure = ({ reason, message, runner }: AgentFailure) =>
  checkoutRunFailure(agentFailureReasons[reason], message, runner)

export interface CheckoutTask<A> {
  readonly instructions: string
  readonly prompt: string
  readonly answer: Schema.Decoder<A>
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

export interface CheckoutRunner {
  readonly identity: AgentRunnerIdentity
  readonly run: <I, A>(run: CheckoutRun<I, A>) => Effect.Effect<A, CheckoutRunFailure>
}

/**
 * Picks the Agent review engine, which must read a PR's code, then runs agent tasks over a
 * read-only checkout of a Revision beside PR material read from GitHub. Each run removes its
 * checkout when it ends.
 */
export class CheckoutRuns extends Context.Service<
  CheckoutRuns,
  {
    readonly select: () => Effect.Effect<CheckoutRunner, CheckoutRunFailure, Scope.Scope>
  }
>()("@glass/server/CheckoutRuns") {
  static readonly layer = Layer.effect(
    CheckoutRuns,
    Effect.gen(function* () {
      const checkouts = yield* Checkouts
      const runners = yield* AgentRunners
      const settings = yield* SettingsStore

      const select = Effect.fnUntraced(function* () {
        const engineSettings = yield* settings.read().pipe(
          Effect.map((current) => engineSettingsOf(current, "agentReviews")),
          Effect.mapError((error) => checkoutRunFailure("not-ready", error.message)),
        )

        if (!readsFiles[engineSettings.engine])
          return yield* checkoutRunFailure(
            "runner",
            "This engine can't read the PR's code. Choose one that can as the Agent review engine in Settings.",
          )

        const selected = yield* runners
          .select(engineSettings)
          .pipe(Effect.mapError(fromAgentFailure))

        const { identity } = selected

        if (!selected.readsFiles)
          return yield* checkoutRunFailure(
            "not-ready",
            "This engine can't be limited to reading the PR's code. Update it, then try again.",
            identity,
          )

        const stale = checkoutRunFailure(
          "stale-revision",
          "The PR has new commits since Glass loaded it. Reload, then try again.",
          identity,
        )

        const run = Effect.fnUntraced(function* <I, A>({
          pr,
          revision,
          subject,
          timeout,
          read,
          task,
        }: CheckoutRun<I, A>) {
          const prepare = read(pr, revision).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning(`Couldn't read the Revision for the ${subject}`, cause),
            ),
            Effect.mapError((error) =>
              Predicate.isTagged(error, "StaleRevision")
                ? stale
                : checkoutRunFailure(
                    "github",
                    "Couldn't read the PR from GitHub. Check your connection, then try again.",
                    identity,
                  ),
            ),
            Effect.flatMap(task),
          )

          const checkOut = checkouts.checkout(pr, revision).pipe(
            Effect.mapError((error) => {
              if (Predicate.isTagged(error, "StaleRevision")) return stale

              if (Predicate.isTagged(error, "NoCredentials"))
                return checkoutRunFailure(
                  "no-access",
                  "Glass isn't signed in to GitHub, so it can't fetch the PR's code.",
                  identity,
                )

              const [reason, message] = checkoutMessages[error.reason]

              return checkoutRunFailure(reason, message, identity)
            }),
          )

          const [prepared, checkout] = yield* Effect.all([prepare, checkOut], {
            concurrency: 2,
          })

          return yield* selected.run({ ...prepared, subject, files: { readOnly: checkout } }).pipe(
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

      return CheckoutRuns.of({ select })
    }),
  )
}
