import {
  type ConnectionError,
  type Event,
  type PullRequestRef,
  PullRequestSubject,
  referenceKey,
  referenceText,
  type SettingsError,
  ThreadError,
} from "@glass/contracts"
import { Array as Arr, Context, Effect, Layer, Ref, Stream } from "effect"
import { EventLog } from "./EventLog"
import { FollowedRepositories } from "./FollowedRepositories"
import { endedEvent, recorded, standingEvents } from "./gitHubEvents"
import { GitHubClient } from "./github/GitHubClient"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import {
  isRepositoryOf,
  type Mirror,
  mirroredPullRequest,
  mirroredRepositoryOf,
  PullRequestMirror,
} from "./PullRequestMirror"
import { Subscriptions } from "./Subscriptions"

const refuse = (message: string) => Effect.fail(new ThreadError({ message }))

export class GitHubSource extends Context.Service<
  GitHubSource,
  {
    readonly subject: (
      pullRequest: PullRequestRef,
    ) => Effect.Effect<
      typeof PullRequestSubject.Type,
      ThreadError | SettingsError | ConnectionError
    >
    readonly standing: (pullRequest: PullRequestRef) => Effect.Effect<ReadonlyArray<Event> | null>
  }
>()("@glass/server/GitHubSource") {
  static readonly layer = Layer.effect(
    GitHubSource,
    Effect.gen(function* () {
      const subscriptions = yield* Subscriptions
      const followed = yield* FollowedRepositories
      const github = yield* GitHubClient
      const mirror = yield* PullRequestMirror
      const events = yield* EventLog
      const endedSeen = yield* Ref.make<ReadonlySet<string>>(new Set())

      const lookUp = (pullRequests: ReadonlyArray<PullRequestRef>) =>
        github
          .queuedPullRequests(pullRequests)
          .pipe(Effect.provideService(BackgroundGitHubRequest, true))

      const subscribed = subscriptions
        .about("github")
        .pipe(Effect.map((states) => states.map(({ subject }) => subject.pullRequest)))

      const recordEnded = Effect.fnUntraced(function* (mirrored: Mirror | undefined) {
        if (mirrored === undefined) return

        const seen = yield* Ref.get(endedSeen)

        const gone = Arr.dedupeWith(
          (yield* subscribed).filter(
            (pullRequest) =>
              !seen.has(referenceKey(pullRequest)) &&
              mirroredRepositoryOf(mirrored, pullRequest) !== undefined &&
              mirroredPullRequest(mirrored, pullRequest) === undefined,
          ),
          (a, b) => referenceKey(a) === referenceKey(b),
        )

        if (gone.length === 0) return

        const ended = Arr.zip(gone, yield* lookUp(gone)).flatMap(([pullRequest, found]) => {
          if (found?.state === "merged" && found.mergedAt !== null)
            return [{ pullRequest, event: endedEvent(found.summary.ref, "merged", found.mergedAt) }]

          return found?.state === "closed" && found.closedAt !== null
            ? [{ pullRequest, event: endedEvent(found.summary.ref, "closed", found.closedAt) }]
            : []
        })

        yield* events.record("github", recorded(ended.map(({ event }) => event)))
        yield* Ref.update(
          endedSeen,
          (before) =>
            new Set([...before, ...ended.map(({ pullRequest }) => referenceKey(pullRequest))]),
        )
      })

      yield* Stream.zipLatest(mirror.changes, subscriptions.changes).pipe(
        Stream.runForEach(([mirrored]) =>
          recordEnded(mirrored).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Couldn't record which subscribed PRs ended", cause),
            ),
          ),
        ),
        Effect.forkScoped,
      )

      yield* mirror.readInDetail(() =>
        subscribed.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Couldn't read which PRs have a Subscription", cause).pipe(
              Effect.as<ReadonlyArray<PullRequestRef>>([]),
            ),
          ),
        ),
      )

      return GitHubSource.of({
        subject: Effect.fnUntraced(function* (pullRequest) {
          if (!(yield* followed.list()).some(isRepositoryOf(pullRequest)))
            return yield* refuse(
              `Glass only knows PRs in the repositories the user follows, and ${pullRequest.owner}/${pullRequest.repo} isn't one. Ask the user to follow it in Glass.`,
            )

          const [found] = yield* lookUp([pullRequest])

          if (found == null)
            return yield* refuse(
              `GitHub has no PR ${referenceText(pullRequest)}, or the user's GitHub login can't see it.`,
            )

          if (found.state === "merged" || found.state === "closed")
            return yield* refuse(
              `PR ${referenceText(pullRequest)} has already ${found.state}, so there's nothing left to tell you about.`,
            )

          return PullRequestSubject.make({ pullRequest: found.summary.ref })
        }),
        standing: (pullRequest) =>
          mirror.afterSync.pipe(
            Effect.map((mirrored) => {
              const pr =
                mirrored === undefined ? undefined : mirroredPullRequest(mirrored, pullRequest)

              return pr === undefined ? null : standingEvents(pr)
            }),
          ),
      })
    }),
  )
}
