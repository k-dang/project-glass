import {
  BinaryFile,
  Branches,
  type ChangedFile,
  type ConnectionError,
  DiscussionNotFound,
  type Discussions,
  Draft,
  DraftNotFound,
  DraftsBlockReply,
  type FileContents,
  type FollowedRepository,
  FileNotFound,
  FileTooLarge,
  GitHubConnection,
  GitHubUnavailable,
  LinePlace,
  type NewDraft,
  PullRequest,
  PullRequestAccessDenied,
  PullRequestNotFound,
  PullRequestRef,
  type PublishedComment,
  type PullRequestState,
  PullRequestWorkspace,
  RepositoryFiles,
  type ReviewDecision,
  ReviewRejected,
  Revision,
  type RevisionSide,
  StaleRevision,
  TextFile,
  TokenRejected,
  type TokenSource,
  Viewer,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  Data,
  DateTime,
  Effect,
  flow,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
  Semaphore,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { createHash } from "node:crypto"
import { ServerConfig } from "../ServerConfig"
import { GitHubChangedFile, toChangedFile } from "./changedFiles"
import {
  COMMENTS_QUERY,
  GitHubComment,
  GitHubReview,
  GitHubReviewThread,
  RESOLVE_THREAD_MUTATION,
  REVIEW_THREADS_QUERY,
  REVIEWS_QUERY,
  toComment,
  toDiscussions,
  UNRESOLVE_THREAD_MUTATION,
} from "./discussions"
import {
  ADD_DRAFT_MUTATION,
  DELETE_COMMENT_MUTATION,
  DRAFT_STATE_QUERY,
  toDrafts,
  UPDATE_DRAFT_MUTATION,
} from "./drafts"
import { fromGitHubSide, toGitHubSide } from "./diffSide"
import { GitHubAuth } from "./GitHubAuth"
import {
  BackgroundGitHubRequest,
  GitHubErrorResponse,
  GitHubRequestPolicy,
} from "./GitHubRequestPolicy"
import {
  type CheckObservation,
  type CandidatesPage,
  PULL_REQUEST_CHECKS_QUERY,
  REPOSITORY_PULL_REQUESTS_QUERY,
  REVIEW_REQUESTS_QUERY,
  type ReviewRequestsPage,
  SEARCH_PULL_REQUESTS_QUERY,
  updatedSinceSearch,
  toCandidatesPage,
  toChecks,
  toReviewRequestsPage,
} from "./repositoryPullRequests"
import { toPullRequestStatus } from "./pullRequestStatus"
import {
  type LookedUpPullRequest,
  QueuedPullRequestsResponse,
  queuedPullRequestsQuery,
  queuedPullRequestsVariables,
  toLookedUpBatch,
} from "./queuedPullRequests"
import { REPLY_MUTATION } from "./replies"
import { ADD_REVIEW_MUTATION, reviewEvents, SUBMIT_REVIEW_MUTATION } from "./reviews"
import { login } from "./author"
import {
  GitHubViewedFile,
  MARK_FILE_VIEWED_MUTATION,
  UNMARK_FILE_VIEWED_MUTATION,
  VIEWED_FILES_QUERY,
} from "./viewedFiles"

import {
  type GraphQLBody,
  type GraphQLError,
  ConnectionPageResponse,
  PULL_REQUEST_QUERY,
  PULL_REQUEST_REVISION_QUERY,
  TOUR_INPUT_QUERY,
  TourInputResponse,
  FILE_CONTENTS_QUERY,
  GitHubPullRequestState,
  PullRequestResponse,
  PullRequestRevisionResponse,
  FileContentsResponse,
  RepositoryPullRequestsResponse,
  SearchPullRequestsResponse,
  PullRequestChecksResponse,
  ReviewRequestsResponse,
  AddDraftResponse,
  DraftStateResponse,
  AddReplyResponse,
  MutationResponse,
  ThreadResolutionResponse,
  REPOSITORY_BRANCHES_QUERY,
  RepositoryBranchesResponse,
} from "./queries"

const GitHubUser = Schema.Struct({ login: Schema.String })

/** GitHub's REST file list returns at most 100 files per page. */
const FILES_PAGE_SIZE = 100

/** REST lists at most 3,000 files for a pull request. */
const MAX_FILE_PAGES = 30

const MAX_OPEN_ATTEMPTS = 3

export interface TourInput {
  readonly title: string
  readonly body: string
  readonly files: ReadonlyArray<ChangedFile>
}

export interface ReviewInput extends TourInput {
  readonly discussions: Discussions
}

const GitTree = Schema.Struct({
  tree: Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String })),
  truncated: Schema.Boolean,
})

const CHECKS_BATCH_SIZE = 100

const QUEUED_BATCH_SIZE = 50

const states: Record<typeof GitHubPullRequestState.Type, PullRequestState> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
}

class CommentGone extends Data.TaggedError("CommentGone") {}

const unavailable = (message: string) => (cause: { readonly message: string }) =>
  Effect.logWarning("GitHub request failed", cause.message).pipe(
    Effect.andThen(Effect.fail(new GitHubUnavailable({ message }))),
  )

const withGitHubDeadline = Effect.timeoutOrElse({
  duration: "30 seconds",
  orElse: () =>
    Effect.fail(
      new GitHubUnavailable({
        message: "GitHub took too long answering. Reload before trying again.",
      }),
    ),
})

const matchesRevision = (
  current: { readonly baseRefOid: string; readonly headRefOid: string },
  revision: Revision,
) => current.baseRefOid === revision.base && current.headRefOid === revision.head

const missingPullRequest = (operation: string) =>
  unavailable("GitHub had a problem answering. Try again in a moment.")({
    message: `GraphQL ${operation} couldn't resolve the pull request it just read`,
  })

const allPages = <A, E>(
  page: (after: string | null) => Effect.Effect<
    {
      readonly nodes: ReadonlyArray<A>
      readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null }
    },
    E
  >,
) => {
  const from = (after: string | null): Effect.Effect<ReadonlyArray<A>, E> =>
    Effect.gen(function* () {
      const { pageInfo, nodes } = yield* page(after)

      if (!pageInfo.hasNextPage || pageInfo.endCursor === null) return nodes

      return [...nodes, ...(yield* from(pageInfo.endCursor))]
    })

  return from(null)
}

export class GitHubClient extends Context.Service<
  GitHubClient,
  {
    readonly viewer: Effect.Effect<GitHubConnection, ConnectionError>
    /** The Connection `viewer` last returned, asking GitHub only before it has returned one. */
    readonly knownViewer: Effect.Effect<GitHubConnection, ConnectionError>
    readonly pullRequest: (
      ref: PullRequestRef,
    ) => Effect.Effect<
      PullRequestWorkspace,
      PullRequestNotFound | PullRequestAccessDenied | ConnectionError
    >
    readonly tourInput: (
      ref: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<TourInput, StaleRevision | ConnectionError>
    readonly reviewInput: (
      ref: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<ReviewInput, StaleRevision | ConnectionError>
    readonly hasChanged: (
      pullRequestId: string,
      revision: Revision,
      updatedAt: DateTime.Utc,
    ) => Effect.Effect<boolean, ConnectionError>
    readonly repositoryPullRequests: (
      repository: FollowedRepository,
      viewerLogin: string,
      after: string | null,
    ) => Effect.Effect<CandidatesPage, ConnectionError>
    readonly pullRequestsUpdatedSince: (
      repository: FollowedRepository,
      since: DateTime.Utc,
      viewerLogin: string,
      after: string | null,
    ) => Effect.Effect<CandidatesPage, ConnectionError>
    readonly pullRequestChecks: (
      pullRequestIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, CheckObservation>, ConnectionError>
    readonly queuedPullRequests: (
      refs: ReadonlyArray<PullRequestRef>,
    ) => Effect.Effect<ReadonlyArray<LookedUpPullRequest | null>, ConnectionError>
    readonly reviewRequests: (
      pullRequestId: string,
      after: string,
    ) => Effect.Effect<ReviewRequestsPage, ConnectionError>
    readonly viewerTeams: Effect.Effect<ReadonlySet<string>, ConnectionError>
    readonly fileContents: (
      ref: PullRequestRef,
      revision: Revision,
      side: RevisionSide,
      path: string,
    ) => Effect.Effect<FileContents, FileNotFound | PullRequestNotFound | ConnectionError>
    readonly repositoryFiles: (
      ref: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<RepositoryFiles, ConnectionError>
    readonly repositoryBranches: (
      repository: FollowedRepository,
    ) => Effect.Effect<Branches, ConnectionError>
    readonly setFileViewed: (
      pullRequestId: string,
      revision: Revision,
      path: string,
      viewed: boolean,
    ) => Effect.Effect<void, StaleRevision | ConnectionError>
    readonly createDraft: (draft: NewDraft) => Effect.Effect<Draft, StaleRevision | ConnectionError>
    readonly updateDraft: (
      id: string,
      body: string,
    ) => Effect.Effect<void, DraftNotFound | ConnectionError>
    readonly deleteDraft: (id: string) => Effect.Effect<void, ConnectionError>
    readonly submitReview: (
      pullRequestId: string,
      revision: Revision,
      decision: ReviewDecision,
      summary: string,
    ) => Effect.Effect<void, StaleRevision | ReviewRejected | ConnectionError>
    readonly replyToDiscussion: (
      discussionId: string,
      body: string,
    ) => Effect.Effect<PublishedComment, DiscussionNotFound | DraftsBlockReply | ConnectionError>
    readonly setDiscussionResolved: (
      discussionId: string,
      resolved: boolean,
    ) => Effect.Effect<boolean, DiscussionNotFound | ConnectionError>
  }
>()("@glass/server/github/GitHubClient") {
  static readonly layerNoDeps = Layer.effect(
    GitHubClient,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const auth = yield* GitHubAuth

      const pendingReviewWrites = yield* Semaphore.make(1)
      const policy = yield* GitHubRequestPolicy
      const readsLock = yield* Semaphore.make(1)

      const reads = new Map<
        string,
        Effect.Effect<{ readonly body: unknown; readonly source: TokenSource }, ConnectionError>
      >()

      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.prependUrl(config.githubApiUrl),
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeaders({
              "user-agent": "Glass",
              "x-github-api-version": "2022-11-28",
            }),
          ),
        ),
      )

      const send = Effect.fnUntraced(function* <A extends Schema.Top>(
        request: HttpClientRequest.HttpClientRequest,
        schema: A,
        readKey?: string,
      ) {
        const { token, source } = yield* auth.resolveToken
        const credential = createHash("sha256").update(Redacted.value(token)).digest("hex")
        const resource = request.url === "/graphql" ? "graphql" : "core"
        const mutation = request.method !== "GET" && readKey === undefined
        const background = yield* BackgroundGitHubRequest

        const key = JSON.stringify([
          credential,
          source,
          background,
          request.url,
          request.urlParams,
          readKey,
        ])

        const perform = policy
          .run(
            credential,
            resource,
            Effect.gen(function* () {
              const response = yield* http
                .execute(HttpClientRequest.bearerToken(request, token))
                .pipe(Effect.catch(unavailable("Check your internet connection, then try again.")))

              if (response.status === 401) {
                return yield* new TokenRejected({ tokenSource: source })
              }

              const body = yield* response.json.pipe(
                Effect.catch((error) =>
                  response.status === 200
                    ? unavailable(
                        "GitHub sent a response Glass couldn't read. Try again in a moment.",
                      )(error)
                    : Effect.succeed(null),
                ),
              )

              yield* policy.observe(
                credential,
                resource,
                response.status,
                response.headers,
                Option.getOrUndefined(Schema.decodeUnknownOption(GitHubErrorResponse)(body)),
              )

              if (response.status !== 200) {
                return yield* new GitHubUnavailable({
                  message: `GitHub had a problem answering (HTTP ${response.status}). Try again in a moment.`,
                })
              }

              return { body, source }
            }),
          )
          .pipe(
            withGitHubDeadline,
            Effect.catchTag("GitHubRequestPaused", ({ retryAt }) =>
              Effect.fail(
                new GitHubUnavailable({
                  message: `GitHub requests are paused until ${new Date(retryAt).toISOString()} to respect its rate limit.`,
                }),
              ),
            ),
          )

        const answer = mutation
          ? yield* Effect.sync(() => reads.clear()).pipe(
              Effect.andThen(perform),
              Effect.onExit(() => Effect.sync(() => reads.clear())),
            )
          : yield* Effect.gen(function* () {
              const shared = yield* Effect.gen(function* () {
                const pending = reads.get(key)

                if (pending !== undefined) return pending

                const created = yield* Effect.cached(
                  perform.pipe(
                    Effect.onExit(() =>
                      Effect.sync(() => {
                        if (reads.get(key) === created) reads.delete(key)
                      }),
                    ),
                  ),
                )

                reads.set(key, created)

                return created
              }).pipe(readsLock.withPermits(1))

              return yield* shared
            })

        const body = yield* Schema.decodeUnknownEffect(schema)(answer.body).pipe(
          Effect.catch(
            unavailable("GitHub sent a response Glass couldn't read. Try again in a moment."),
          ),
        )

        return { body, source: answer.source }
      }, withGitHubDeadline)

      const graphql = Effect.fnUntraced(function* <Data, E>(operation: {
        readonly name: string
        readonly query: string
        readonly variables: Record<string, string | number | ReadonlyArray<string> | null>
        readonly response: Schema.Codec<GraphQLBody<Data>, unknown>
        readonly domainError: (error: GraphQLError) => E | undefined
      }) {
        const { body } = yield* send(
          HttpClientRequest.post("/graphql").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              operationName: operation.name,
              query: operation.query,
              variables: operation.variables,
            }),
          ),
          operation.response,
          /^\s*mutation\b/.test(operation.query)
            ? undefined
            : JSON.stringify([operation.query, operation.variables]),
        )

        for (const error of body.errors ?? []) {
          const domainError = operation.domainError(error)

          if (domainError !== undefined) return yield* Effect.fail(domainError)
        }

        if (body.errors !== undefined || body.data == null) {
          return yield* unavailable("GitHub had a problem answering. Try again in a moment.")({
            message: body.errors?.[0]?.message ?? `GraphQL ${operation.name} answered without data`,
          })
        }

        return body.data
      })

      let lastViewer: GitHubConnection | null = null

      const viewer = send(HttpClientRequest.get("/user"), GitHubUser).pipe(
        Effect.map(
          ({ body, source }) => new GitHubConnection({ login: body.login, tokenSource: source }),
        ),
        Effect.tap((connection) =>
          Effect.sync(() => {
            lastViewer = connection
          }),
        ),
        Effect.withSpan("GitHubClient.viewer"),
      )

      const knownViewer = Effect.suspend(() =>
        lastViewer === null ? viewer : Effect.succeed(lastViewer),
      )

      /** GitHub's REST file list cannot be pinned to a base/head pair. */
      const pullRequest = Effect.fn("GitHubClient.pullRequest")(function* (ref: PullRequestRef) {
        for (let attempt = 1; ; attempt++) {
          const workspace = yield* readPullRequest(ref)

          if (yield* isCurrent(workspace.pullRequest.id, workspace.revision)) return workspace

          if (attempt === MAX_OPEN_ATTEMPTS) {
            return yield* new GitHubUnavailable({
              message: "The pull request kept changing while Glass read it. Try again in a moment.",
            })
          }
        }
      })

      const readPullRequest = Effect.fnUntraced(function* (ref: PullRequestRef) {
        const data = yield* graphql({
          name: "PullRequest",
          query: PULL_REQUEST_QUERY,
          variables: { owner: ref.owner, name: ref.repo, number: ref.number },
          response: PullRequestResponse,
          domainError: ({ type, message }) => {
            if (type === "NOT_FOUND") return new PullRequestNotFound({ ref })

            if (type === "FORBIDDEN") return new PullRequestAccessDenied({ ref, message })

            return undefined
          },
        })

        const pr = data.repository?.pullRequest

        if (pr == null) return yield* new PullRequestNotFound({ ref })

        const canonical = new PullRequestRef({
          owner: pr.repository.owner.login,
          repo: pr.repository.name,
          number: pr.number,
        })

        const [gitHubFiles, [threads, comments, reviews], viewedFiles] = yield* Effect.all(
          [
            changedFiles(canonical),
            discussionNodes(pr.id),
            allNodes("PullRequestViewedFiles", VIEWED_FILES_QUERY, GitHubViewedFile, pr.id),
          ],
          { concurrency: "unbounded" },
        )

        const files = gitHubFiles.map(toChangedFile)

        return new PullRequestWorkspace({
          viewer: new Viewer(data.viewer),
          pullRequest: new PullRequest({
            id: pr.id,
            ref: canonical,
            url: pr.url,
            title: pr.title,
            author: login(pr.author),
            baseBranch: pr.baseRefName,
            headBranch: pr.headRefName,
            state: pr.state === "OPEN" && pr.isDraft ? "draft" : states[pr.state],
            descriptionHtml: pr.bodyHTML,
            viewerIsAuthor: pr.viewerDidAuthor,
            ...toPullRequestStatus(pr),
          }),
          revision: new Revision({ base: pr.baseRefOid, head: pr.headRefOid }),
          updatedAt: pr.updatedAt,
          files,
          viewedPaths: viewedFiles.flatMap((file) =>
            file.viewerViewedState === "VIEWED" ? [file.path] : [],
          ),
          discussions: toDiscussions(files, threads, comments, reviews),
          drafts: toDrafts(files, threads),
        })
      })

      const isCurrent = Effect.fnUntraced(function* (pullRequestId: string, revision: Revision) {
        return matchesRevision(yield* currentRevision(pullRequestId), revision)
      })

      const hasChanged = Effect.fn("GitHubClient.hasChanged")(function* (
        pullRequestId: string,
        revision: Revision,
        updatedAt: DateTime.Utc,
      ) {
        const current = yield* currentRevision(pullRequestId)

        return (
          !matchesRevision(current, revision) || !DateTime.Equivalence(current.updatedAt, updatedAt)
        )
      })

      const setFileViewed = Effect.fn("GitHubClient.setFileViewed")(function* (
        pullRequestId: string,
        revision: Revision,
        path: string,
        viewed: boolean,
      ) {
        if (!(yield* isCurrent(pullRequestId, revision))) yield* new StaleRevision()

        yield* graphql({
          name: viewed ? "MarkFileAsViewed" : "UnmarkFileAsViewed",
          query: viewed ? MARK_FILE_VIEWED_MUTATION : UNMARK_FILE_VIEWED_MUTATION,
          variables: { pullRequestId, path },
          response: MutationResponse,
          domainError: () => undefined,
        })
      })

      const currentRevision = Effect.fnUntraced(function* (pullRequestId: string) {
        const { node } = yield* graphql({
          name: "PullRequestRevision",
          query: PULL_REQUEST_REVISION_QUERY,
          variables: { id: pullRequestId },
          response: PullRequestRevisionResponse,
          domainError: () => undefined,
        })

        return node ?? (yield* missingPullRequest("PullRequestRevision"))
      })

      const allNodes = <A>(
        name: string,
        query: string,
        node: Schema.Codec<A, unknown>,
        pullRequestId: string,
      ) => {
        const response = ConnectionPageResponse(node)

        return allPages((after) =>
          Effect.gen(function* () {
            const data = yield* graphql({
              name,
              query,
              variables: { id: pullRequestId, after },
              response,
              domainError: () => undefined,
            })

            if (data.node == null) return yield* missingPullRequest(name)

            return data.node.connection
          }),
        )
      }

      const discussionNodes = (pullRequestId: string) =>
        Effect.all(
          [
            allNodes(
              "PullRequestReviewThreads",
              REVIEW_THREADS_QUERY,
              GitHubReviewThread,
              pullRequestId,
            ),
            allNodes("PullRequestComments", COMMENTS_QUERY, GitHubComment, pullRequestId),
            allNodes("PullRequestReviews", REVIEWS_QUERY, GitHubReview, pullRequestId),
          ],
          { concurrency: "unbounded" },
        )

      const changedFiles = Effect.fnUntraced(function* ({ owner, repo, number }: PullRequestRef) {
        const files: Array<GitHubChangedFile> = []

        for (let page = 1; page <= MAX_FILE_PAGES; page++) {
          const { body } = yield* send(
            HttpClientRequest.get(`/repos/${owner}/${repo}/pulls/${number}/files`).pipe(
              HttpClientRequest.setUrlParams({ per_page: FILES_PAGE_SIZE, page }),
            ),
            Schema.Array(GitHubChangedFile),
          )

          files.push(...body)

          if (body.length < FILES_PAGE_SIZE) break
        }

        return files
      })

      const pinnedPullRequest = Effect.fnUntraced(function* (
        ref: PullRequestRef,
        revision: Revision,
      ) {
        const data = yield* graphql({
          name: "TourInput",
          query: TOUR_INPUT_QUERY,
          variables: { owner: ref.owner, name: ref.repo, number: ref.number },
          response: TourInputResponse,
          domainError: () => undefined,
        })

        const pr = data.repository?.pullRequest

        if (pr == null) return yield* missingPullRequest("TourInput")

        if (!matchesRevision(pr, revision)) return yield* new StaleRevision()

        return pr
      })

      const tourInput = Effect.fn("GitHubClient.tourInput")(function* (
        ref: PullRequestRef,
        revision: Revision,
      ) {
        const pr = yield* pinnedPullRequest(ref, revision)
        const files = yield* changedFiles(ref)

        if (!(yield* isCurrent(pr.id, revision))) return yield* new StaleRevision()

        return { title: pr.title, body: pr.body, files: files.map(toChangedFile) }
      })

      const reviewInput = Effect.fn("GitHubClient.reviewInput")(function* (
        ref: PullRequestRef,
        revision: Revision,
      ) {
        const pr = yield* pinnedPullRequest(ref, revision)

        const [gitHubFiles, [threads, comments, reviews]] = yield* Effect.all(
          [changedFiles(ref), discussionNodes(pr.id)],
          { concurrency: "unbounded" },
        )

        if (!(yield* isCurrent(pr.id, revision))) return yield* new StaleRevision()

        const files = gitHubFiles.map(toChangedFile)

        return {
          title: pr.title,
          body: pr.body,
          files,
          discussions: toDiscussions(files, threads, comments, reviews),
        }
      })

      const repositoryPullRequests = Effect.fn("GitHubClient.repositoryPullRequests")(function* (
        ref: FollowedRepository,
        viewerLogin: string,
        after: string | null,
      ) {
        const { repository } = yield* graphql({
          name: "RepositoryPullRequests",
          query: REPOSITORY_PULL_REQUESTS_QUERY,
          variables: { owner: ref.owner, name: ref.repo, viewerLogin, after },
          response: RepositoryPullRequestsResponse,
          domainError: () => undefined,
        })

        if (repository === null)
          return yield* new GitHubUnavailable({
            message: "Couldn't read this repository's pull requests. Try again.",
          })

        return toCandidatesPage(repository.pullRequests)
      })

      const pullRequestsUpdatedSince = Effect.fn("GitHubClient.pullRequestsUpdatedSince")(
        function* (
          repository: FollowedRepository,
          since: DateTime.Utc,
          viewerLogin: string,
          after: string | null,
        ) {
          const { search } = yield* graphql({
            name: "SearchPullRequests",
            query: SEARCH_PULL_REQUESTS_QUERY,
            variables: { query: updatedSinceSearch(repository, since), viewerLogin, after },
            response: SearchPullRequestsResponse,
            domainError: () => undefined,
          })

          return toCandidatesPage(search)
        },
      )

      const pullRequestChecks = Effect.fn("GitHubClient.pullRequestChecks")(function* (
        pullRequestIds: ReadonlyArray<string>,
      ) {
        const batches = yield* Effect.forEach(
          Arr.chunksOf(pullRequestIds, CHECKS_BATCH_SIZE),
          (ids) =>
            graphql({
              name: "PullRequestChecks",
              query: PULL_REQUEST_CHECKS_QUERY,
              variables: { ids },
              response: PullRequestChecksResponse,
              domainError: () => undefined,
            }).pipe(Effect.map(toChecks)),
          { concurrency: "unbounded" },
        )

        return new Map(batches.flatMap((checks) => [...checks]))
      })

      const lookUpQueued = Effect.fnUntraced(function* (refs: ReadonlyArray<PullRequestRef>) {
        const { body } = yield* send(
          HttpClientRequest.post("/graphql").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              operationName: "QueuedPullRequests",
              query: queuedPullRequestsQuery(refs.length),
              variables: queuedPullRequestsVariables(refs),
            }),
          ),
          QueuedPullRequestsResponse,
          JSON.stringify(["QueuedPullRequests", refs]),
        )

        return yield* Result.match(toLookedUpBatch(refs.length, body), {
          onSuccess: Effect.succeed,
          onFailure: (message) =>
            unavailable("GitHub had a problem answering. Try again in a moment.")({ message }),
        })
      })

      const queuedPullRequests = Effect.fn("GitHubClient.queuedPullRequests")(function* (
        refs: ReadonlyArray<PullRequestRef>,
      ) {
        const batches = yield* Effect.forEach(Arr.chunksOf(refs, QUEUED_BATCH_SIZE), lookUpQueued, {
          concurrency: "unbounded",
        })

        return batches.flat()
      })

      const reviewRequests = Effect.fn("GitHubClient.reviewRequests")(function* (
        pullRequestId: string,
        after: string,
      ) {
        const { node } = yield* graphql({
          name: "PullRequestReviewRequests",
          query: REVIEW_REQUESTS_QUERY,
          variables: { id: pullRequestId, after },
          response: ReviewRequestsResponse,
          domainError: () => undefined,
        })

        if (node === null) return yield* missingPullRequest("PullRequestReviewRequests")

        const page = toReviewRequestsPage(node.connection)

        if (page.nextCursor === after)
          return yield* new GitHubUnavailable({
            message: "GitHub couldn't continue the review requests. Try again.",
          })

        return page
      })

      const viewerTeams = Effect.gen(function* () {
        const teams = new Set<string>()

        const schema = Schema.Array(
          Schema.Struct({
            slug: Schema.String,
            organization: Schema.Struct({ login: Schema.String }),
          }),
        )

        for (let page = 1; ; page++) {
          const { body } = yield* send(
            HttpClientRequest.get("/user/teams").pipe(
              HttpClientRequest.setUrlParams({ per_page: 100, page }),
            ),
            schema,
          )

          for (const team of body)
            teams.add(`${team.organization.login}/${team.slug}`.toLowerCase())

          if (body.length < 100) return teams
        }
      })

      const fileContents = Effect.fn("GitHubClient.fileContents")(function* (
        ref: PullRequestRef,
        revision: Revision,
        side: RevisionSide,
        path: string,
      ) {
        const commit = revision[side]

        const { repository } = yield* graphql({
          name: "FileContents",
          query: FILE_CONTENTS_QUERY,
          variables: { owner: ref.owner, name: ref.repo, expression: `${commit}:${path}` },
          response: FileContentsResponse,
          domainError: ({ type }) =>
            type === "NOT_FOUND" ? new PullRequestNotFound({ ref }) : undefined,
        })

        const object = repository?.object

        if (object == null || object.__typename !== "Blob") {
          return yield* new FileNotFound({ path, side })
        }

        if (object.isBinary === true || object.text === null) return BinaryFile.make({})

        if (object.isTruncated) return FileTooLarge.make({})

        return TextFile.make({ text: object.text })
      })

      const repositoryFiles = Effect.fn("GitHubClient.repositoryFiles")(function* (
        { owner, repo }: PullRequestRef,
        revision: Revision,
      ) {
        const { body } = yield* send(
          HttpClientRequest.get(`/repos/${owner}/${repo}/git/trees/${revision.head}`).pipe(
            HttpClientRequest.setUrlParams({ recursive: 1 }),
          ),
          GitTree,
        )

        return new RepositoryFiles({
          paths: body.tree.flatMap((entry) => (entry.type === "blob" ? [entry.path] : [])),
          truncated: body.truncated,
        })
      })

      const repositoryBranches = (repository: FollowedRepository) => {
        const notFound = new GitHubUnavailable({
          message: `GitHub couldn't find ${repository.owner}/${repository.repo}. Check you can open it on GitHub.`,
        })

        let defaultBranch: string | null = null

        return allPages((after) =>
          Effect.gen(function* () {
            const data = yield* graphql({
              name: "RepositoryBranches",
              query: REPOSITORY_BRANCHES_QUERY,
              variables: { owner: repository.owner, name: repository.repo, after },
              response: RepositoryBranchesResponse,
              domainError: ({ type }) => (type === "NOT_FOUND" ? notFound : undefined),
            })

            if (data.repository === null) return yield* notFound

            defaultBranch = data.repository.defaultBranchRef?.name ?? null

            return data.repository.refs
          }),
        ).pipe(
          Effect.map(
            (refs) => new Branches({ defaultBranch, branches: refs.map(({ name }) => name) }),
          ),
          Effect.withSpan("GitHubClient.repositoryBranches"),
        )
      }

      /** GitHub places new Drafts on the current head; this mutation has no commit precondition. */
      const createDraft = Effect.fn("GitHubClient.createDraft")(function* (draft: NewDraft) {
        if (!(yield* isCurrent(draft.pullRequestId, draft.revision))) {
          return yield* new StaleRevision()
        }

        const { addPullRequestReviewThread } = yield* graphql({
          name: "AddPullRequestReviewThread",
          query: ADD_DRAFT_MUTATION,
          variables: {
            pullRequestId: draft.pullRequestId,
            path: draft.path,
            line: draft.line,
            side: toGitHubSide(draft.side),
            body: draft.body,
          },
          response: AddDraftResponse,
          domainError: () => undefined,
        })

        const thread = addPullRequestReviewThread?.thread
        const comment = thread?.comments.nodes[0]

        if (thread == null || thread.line === null || comment === undefined) {
          return yield* unavailable(
            "GitHub didn't accept a Draft on that line. Reload, then try again.",
          )({
            message: `GraphQL AddPullRequestReviewThread placed no thread on ${draft.path}:${draft.line}`,
          })
        }

        return new Draft({
          id: comment.id,
          path: thread.path,
          place: LinePlace.make({ side: fromGitHubSide(thread.diffSide), line: thread.line }),
          body: comment.body,
        })
      }, pendingReviewWrites.withPermits(1))

      const requirePending = Effect.fnUntraced(function* (id: string) {
        const { node } = yield* graphql({
          name: "DraftState",
          query: DRAFT_STATE_QUERY,
          variables: { id },
          response: DraftStateResponse,
          domainError: ({ type }) => (type === "NOT_FOUND" ? new DraftNotFound({ id }) : undefined),
        })

        if (node?.state !== "PENDING") yield* new DraftNotFound({ id })
      })

      const updateDraft = Effect.fn("GitHubClient.updateDraft")(function* (
        id: string,
        body: string,
      ) {
        yield* requirePending(id)
        yield* graphql({
          name: "UpdatePullRequestReviewComment",
          query: UPDATE_DRAFT_MUTATION,
          variables: { id, body },
          response: MutationResponse,
          domainError: ({ type }) => (type === "NOT_FOUND" ? new DraftNotFound({ id }) : undefined),
        })
      }, pendingReviewWrites.withPermits(1))

      const deleteComment = (id: string) =>
        graphql({
          name: "DeletePullRequestReviewComment",
          query: DELETE_COMMENT_MUTATION,
          variables: { id },
          response: MutationResponse,
          domainError: ({ type }) => (type === "NOT_FOUND" ? new CommentGone() : undefined),
        }).pipe(Effect.catchTag("CommentGone", () => Effect.void))

      const deleteDraft = Effect.fn("GitHubClient.deleteDraft")(
        function* (id: string) {
          yield* requirePending(id)
          yield* deleteComment(id)
        },
        Effect.catchTag("DraftNotFound", () => Effect.void),
        pendingReviewWrites.withPermits(1),
      )

      const submitReview = Effect.fn("GitHubClient.submitReview")(function* (
        pullRequestId: string,
        revision: Revision,
        decision: ReviewDecision,
        summary: string,
      ) {
        const current = yield* currentRevision(pullRequestId)

        if (!matchesRevision(current, revision)) yield* new StaleRevision()

        const pendingReview = current.reviews.nodes[0]
        const event = reviewEvents[decision]
        const body = summary.trim() === "" ? null : summary

        const operation =
          pendingReview === undefined
            ? {
                name: "AddPullRequestReview",
                query: ADD_REVIEW_MUTATION,
                variables: { pullRequestId, event, body },
              }
            : {
                name: "SubmitPullRequestReview",
                query: SUBMIT_REVIEW_MUTATION,
                variables: { pullRequestReviewId: pendingReview.id, event, body },
              }

        yield* graphql({
          ...operation,
          response: MutationResponse,
          domainError: ({ type, message }) =>
            type === "UNPROCESSABLE" ? new ReviewRejected({ message }) : undefined,
        })
      }, pendingReviewWrites.withPermits(1))

      const replyToDiscussion = Effect.fn("GitHubClient.replyToDiscussion")(function* (
        discussionId: string,
        body: string,
      ) {
        const { addPullRequestReviewThreadReply } = yield* Effect.acquireUseRelease(
          graphql({
            name: "AddPullRequestReviewThreadReply",
            query: REPLY_MUTATION,
            variables: { pullRequestReviewThreadId: discussionId, body },
            response: AddReplyResponse,
            domainError: ({ type }) =>
              type === "NOT_FOUND" ? new DiscussionNotFound({ id: discussionId }) : undefined,
          }),
          Effect.succeed,
          (result) => {
            const comment = result.addPullRequestReviewThreadReply?.comment

            return comment?.state === "PENDING" ? deleteComment(comment.id) : Effect.void
          },
        )

        const comment = addPullRequestReviewThreadReply?.comment

        if (comment == null) {
          return yield* unavailable("GitHub didn't accept the Reply. Try again in a moment.")({
            message: `GraphQL AddPullRequestReviewThreadReply added no comment to ${discussionId}`,
          })
        }

        if (comment.state === "PENDING") {
          return yield* new DraftsBlockReply()
        }

        return toComment(comment)
      }, pendingReviewWrites.withPermits(1))

      const setDiscussionResolved = Effect.fn("GitHubClient.setDiscussionResolved")(function* (
        discussionId: string,
        resolved: boolean,
      ) {
        const name = resolved ? "ResolveReviewThread" : "UnresolveReviewThread"

        const data = yield* graphql({
          name,
          query: resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION,
          variables: { threadId: discussionId },
          response: ThreadResolutionResponse,
          domainError: ({ type }) =>
            type === "NOT_FOUND" ? new DiscussionNotFound({ id: discussionId }) : undefined,
        })

        const thread = (resolved ? data.resolveReviewThread : data.unresolveReviewThread)?.thread

        if (thread == null) {
          return yield* unavailable("GitHub didn't update the Discussion. Try again in a moment.")({
            message: `GraphQL ${name} returned no thread for ${discussionId}`,
          })
        }

        return thread.isResolved
      })

      return GitHubClient.of({
        viewer,
        knownViewer,
        pullRequest,
        tourInput,
        reviewInput,
        hasChanged,
        repositoryPullRequests,
        pullRequestsUpdatedSince,
        pullRequestChecks,
        queuedPullRequests,
        reviewRequests,
        viewerTeams,
        fileContents,
        repositoryFiles,
        repositoryBranches,
        setFileViewed,
        createDraft,
        updateDraft,
        deleteDraft,
        submitReview,
        replyToDiscussion,
        setDiscussionResolved,
      })
    }),
  )

  static readonly layer = GitHubClient.layerNoDeps.pipe(
    Layer.provide(GitHubRequestPolicy.layer),
    Layer.provide(FetchHttpClient.layer),
  )
}
