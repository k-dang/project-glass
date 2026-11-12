import {
  Checks,
  type ConnectionError,
  FollowedRepository,
  GitHubUnavailable,
  PullRequestRef,
  repositoryKey,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Order,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import { join } from "node:path"
import { writeDataFile } from "./dataFiles"
import { GitHubClient } from "./github/GitHubClient"
import type { Candidate, CandidatesPage, CheckObservation } from "./github/repositoryPullRequests"
import { ServerConfig } from "./ServerConfig"

const FULL_READ_INTERVAL = Duration.minutes(10)

const CATCH_UP_OVERLAP = Duration.minutes(5)

const MirroredPullRequest = Schema.Struct({
  id: Schema.String,
  ref: PullRequestRef,
  url: Schema.String,
  title: Schema.String,
  author: Schema.String,
  isDraft: Schema.Boolean,
  updatedAt: Schema.DateTimeUtcFromString,
  head: Schema.String,
  checks: Checks,
  viewerIsAuthor: Schema.Boolean,
  viewerHasDrafts: Schema.Boolean,
  viewerHasSubmittedReview: Schema.Boolean,
  requestedUsers: Schema.Array(Schema.String),
  requestedTeams: Schema.Array(Schema.String),
})

export type MirroredPullRequest = typeof MirroredPullRequest.Type

const RepositoryMirror = Schema.Struct({
  repository: FollowedRepository,
  fullyReadAt: Schema.DateTimeUtcFromString,
  syncedAt: Schema.DateTimeUtcFromString,
  pullRequests: Schema.Array(MirroredPullRequest),
})

type RepositoryMirror = typeof RepositoryMirror.Type

const Mirror = Schema.Struct({
  viewer: Schema.String,
  teams: Schema.Array(Schema.String),
  repositories: Schema.Array(RepositoryMirror),
})

export type Mirror = typeof Mirror.Type

const mirrorFile = Schema.fromJsonString(Mirror)

const decodeMirror = Schema.decodeUnknownEffect(mirrorFile)

const encodeMirror = Schema.encodeEffect(mirrorFile)

export const mirrorOf = (mirror: Mirror, repository: FollowedRepository) =>
  mirror.repositories.find(
    (candidate) => repositoryKey(candidate.repository) === repositoryKey(repository),
  )

const newestFirst = (pullRequests: ReadonlyArray<MirroredPullRequest>) =>
  Arr.sortWith(pullRequests, (pr) => pr.updatedAt, Order.flip(DateTime.Order))

export interface Synced {
  readonly mirror: Mirror
  readonly failures: ReadonlyMap<string, GitHubUnavailable>
}

export class PullRequestMirror extends Context.Service<
  PullRequestMirror,
  {
    readonly saved: Effect.Effect<Mirror | undefined>
    readonly sync: (
      viewer: string,
      followed: ReadonlyArray<FollowedRepository>,
      shown: (mirror: Mirror) => ReadonlyArray<MirroredPullRequest>,
    ) => Effect.Effect<Synced, ConnectionError>
  }
>()("@glass/server/PullRequestMirror") {
  static readonly layer = Layer.effect(
    PullRequestMirror,
    Effect.gen(function* () {
      const github = yield* GitHubClient
      const fs = yield* FileSystem.FileSystem
      const { dataDirectory } = yield* ServerConfig
      const path = join(dataDirectory, "pull-requests.json")
      const lock = yield* Semaphore.make(1)

      const loaded = yield* fs.readFileString(path).pipe(
        Effect.flatMap(decodeMirror),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't read the saved PR lists", cause).pipe(Effect.as(undefined)),
        ),
      )

      const state = yield* Ref.make<Mirror | undefined>(loaded)

      const commit = Effect.fnUntraced(function* (mirror: Mirror) {
        yield* Ref.set(state, mirror)
        yield* encodeMirror(mirror).pipe(
          Effect.flatMap((json) => writeDataFile(fs, path, json)),
          Effect.catch((error) => Effect.logWarning("Couldn't save the PR lists", error)),
        )
      })

      const allPages = Effect.fnUntraced(function* (
        pageAt: (cursor: string | null) => Effect.Effect<CandidatesPage, ConnectionError>,
      ) {
        const candidates: Array<Candidate> = []
        let cursor: string | null = null

        for (;;) {
          const page: CandidatesPage = yield* pageAt(cursor)
          candidates.push(...page.candidates)

          if (page.nextCursor === null) return candidates

          if (page.nextCursor === cursor) {
            return yield* new GitHubUnavailable({
              message: "GitHub couldn't continue the PR list. Try again.",
            })
          }

          cursor = page.nextCursor
        }
      })

      const mirrored = Effect.fnUntraced(function* (
        { isOpen: _isOpen, reviewRequests, ...fields }: Candidate,
        before: RepositoryMirror | undefined,
      ) {
        const requestedUsers = [...reviewRequests.users]
        const requestedTeams = [...reviewRequests.teams]
        let next = reviewRequests.nextCursor

        while (next !== null) {
          const page = yield* github.reviewRequests(fields.id, next)
          requestedUsers.push(...page.users)
          requestedTeams.push(...page.teams)
          next = page.nextCursor
        }

        const known = before?.pullRequests.find((pr) => pr.id === fields.id)

        return {
          ...fields,
          checks: known?.head === fields.head ? known.checks : "unavailable",
          requestedUsers,
          requestedTeams,
        } satisfies MirroredPullRequest
      })

      const readAll = Effect.fnUntraced(function* (
        viewer: string,
        repository: FollowedRepository,
        before: RepositoryMirror | undefined,
        now: DateTime.Utc,
      ) {
        const candidates = yield* allPages((cursor) =>
          github.repositoryPullRequests(repository, viewer, cursor),
        )

        return {
          repository,
          fullyReadAt: now,
          syncedAt: now,
          pullRequests: yield* Effect.forEach(candidates, (candidate) =>
            mirrored(candidate, before),
          ),
        } satisfies RepositoryMirror
      })

      const catchUp = Effect.fnUntraced(function* (
        viewer: string,
        before: RepositoryMirror,
        now: DateTime.Utc,
      ) {
        const since = DateTime.subtractDuration(before.syncedAt, CATCH_UP_OVERLAP)

        const changed = yield* allPages((cursor) =>
          github.pullRequestsUpdatedSince(before.repository, since, viewer, cursor),
        )

        const changedIds = new Set(changed.map((candidate) => candidate.id))

        const updated = yield* Effect.forEach(
          changed.filter((candidate) => candidate.isOpen),
          (candidate) => mirrored(candidate, before),
        )

        return {
          ...before,
          syncedAt: now,
          pullRequests: newestFirst([
            ...updated,
            ...before.pullRequests.filter((pr) => !changedIds.has(pr.id)),
          ]),
        } satisfies RepositoryMirror
      })

      const withLatestChecks = Effect.fnUntraced(function* (
        mirror: Mirror,
        shown: ReadonlyArray<MirroredPullRequest>,
      ) {
        const result = yield* github.pullRequestChecks(shown.map((pr) => pr.id)).pipe(
          Effect.tapError((error) => Effect.logWarning("Couldn't read PR checks", error)),
          Effect.match({
            onSuccess: (checks) => ({ checks, problem: null }),
            onFailure: (error) => ({
              checks: new Map<string, CheckObservation>(),
              problem: new GitHubUnavailable({
                message: `Checks couldn't refresh. ${error.message}`,
              }),
            }),
          }),
        )

        const shownRepositories = new Set(shown.map((pr) => repositoryKey(pr.ref)))
        const problem = result.problem

        return {
          mirror: {
            ...mirror,
            repositories: mirror.repositories.map((repository) => ({
              ...repository,
              pullRequests: repository.pullRequests.map((pr) => {
                const observed = result.checks.get(pr.id)

                return observed === undefined ? pr : { ...pr, ...observed }
              }),
            })),
          } satisfies Mirror,
          failures: new Map(
            problem === null ? [] : [...shownRepositories].map((key) => [key, problem] as const),
          ),
        }
      })

      const sync = Effect.fn("PullRequestMirror.sync")(function* (
        viewer: string,
        followed: ReadonlyArray<FollowedRepository>,
        shown: (mirror: Mirror) => ReadonlyArray<MirroredPullRequest>,
      ) {
        const now = yield* DateTime.now
        const current = yield* Ref.get(state)

        const previous =
          current?.viewer.toLowerCase() === viewer.toLowerCase() ? current : undefined

        const plans = followed.map((repository) => {
          const before = previous === undefined ? undefined : mirrorOf(previous, repository)

          const full =
            before === undefined ||
            Duration.isGreaterThanOrEqualTo(
              DateTime.distance(before.fullyReadAt, now),
              FULL_READ_INTERVAL,
            )

          return {
            repository,
            before,
            full,
            read:
              before === undefined || full
                ? readAll(viewer, repository, before, now)
                : catchUp(viewer, before, now),
          }
        })

        const repositories = Effect.forEach(
          plans,
          ({ repository, before, read }) =>
            read.pipe(
              Effect.map((mirror) => ({ repository, mirror, failure: undefined })),
              Effect.catchTag("GitHubUnavailable", (failure) =>
                Effect.succeed({ repository, mirror: before, failure }),
              ),
            ),
          { concurrency: 4 },
        )

        const teams =
          previous === undefined || plans.some(({ full }) => full)
            ? Effect.map(github.viewerTeams, (memberships) => [...memberships])
            : Effect.succeed(previous.teams)

        const [results, memberships] = yield* Effect.all([repositories, teams], {
          concurrency: "unbounded",
        })

        const synced: Mirror = {
          viewer,
          teams: memberships,
          repositories: results.flatMap((result) =>
            result.mirror === undefined ? [] : [result.mirror],
          ),
        }

        const { mirror, failures } = yield* withLatestChecks(synced, shown(synced))
        yield* commit(mirror)

        return {
          mirror,
          failures: new Map([
            ...failures,
            ...results.flatMap(({ repository, failure }) =>
              failure === undefined ? [] : [[repositoryKey(repository), failure] as const],
            ),
          ]),
        } satisfies Synced
      }, lock.withPermits(1))

      return PullRequestMirror.of({ saved: Ref.get(state), sync })
    }),
  )
}
