import {
  type ChangedFile,
  Discussions,
  LineDiscussion,
  OutdatedDiscussion,
  PublishedComment,
  Review,
  type ReviewState,
} from "@glass/contracts"
import { Array as Arr, DateTime, Predicate, Schema } from "effect"
import { avatarUrl, GitHubAuthor, login } from "./author"
import { fromGitHubSide, GitHubDiffSide } from "./diffSide"

/** GitHub returns at most 100 comments per page. */
export const REVIEW_THREADS_QUERY = `query PullRequestReviewThreads($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      connection: reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          diffSide
          subjectType
          comments(first: 100) {
            nodes { id author { login avatarUrl(size: 48) } body bodyHTML createdAt state diffHunk }
          }
        }
      }
    }
  }
}`

export const COMMENTS_QUERY = `query PullRequestComments($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      connection: comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id author { login avatarUrl(size: 48) } bodyHTML createdAt }
      }
    }
  }
}`

export const RESOLVE_THREAD_MUTATION = `mutation ResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`

export const UNRESOLVE_THREAD_MUTATION = `mutation UnresolveReviewThread($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
}`

const ResolvedThread = Schema.Struct({
  thread: Schema.NullOr(Schema.Struct({ isResolved: Schema.Boolean })),
})

export const ThreadResolution = Schema.Struct({
  resolveReviewThread: Schema.optional(Schema.NullOr(ResolvedThread)),
  unresolveReviewThread: Schema.optional(Schema.NullOr(ResolvedThread)),
})

export const REVIEWS_QUERY = `query PullRequestReviews($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      connection: reviews(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id author { login } state bodyHTML submittedAt }
      }
    }
  }
}`

export const GitHubReviewThread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  originalLine: Schema.NullOr(Schema.Int),
  diffSide: GitHubDiffSide,
  subjectType: Schema.Literals(["LINE", "FILE"]),
  comments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        author: GitHubAuthor,
        body: Schema.String,
        bodyHTML: Schema.String,
        createdAt: Schema.DateTimeUtcFromString,
        state: Schema.Literals(["PENDING", "SUBMITTED"]),
        diffHunk: Schema.String,
      }),
    ),
  }),
})

export const GitHubComment = Schema.Struct({
  id: Schema.String,
  author: GitHubAuthor,
  bodyHTML: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
})

export const GitHubReview = Schema.Struct({
  id: Schema.String,
  author: GitHubAuthor,
  state: Schema.Literals(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]),
  bodyHTML: Schema.String,
  submittedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
})

const states: Record<Exclude<typeof GitHubReview.Type.state, "PENDING">, ReviewState> = {
  COMMENTED: "comment",
  APPROVED: "approve",
  CHANGES_REQUESTED: "request-changes",
  DISMISSED: "dismissed",
}

export const toComment = (comment: typeof GitHubComment.Type) =>
  new PublishedComment({
    id: comment.id,
    author: login(comment.author),
    avatarUrl: avatarUrl(comment.author),
    bodyHtml: comment.bodyHTML,
    createdAt: comment.createdAt,
  })

const timelineTime = (item: PublishedComment | Review) =>
  item instanceof Review ? item.submittedAt : item.createdAt

export const textDiffPaths = (files: ReadonlyArray<ChangedFile>): ReadonlySet<string> =>
  new Set(files.flatMap((file) => (Predicate.isTagged(file.patch, "TextPatch") ? [file.path] : [])))

export const isOnLine = (
  thread: typeof GitHubReviewThread.Type,
  shown: ReadonlySet<string>,
): thread is typeof GitHubReviewThread.Type & { readonly line: number } =>
  thread.subjectType === "LINE" &&
  !thread.isOutdated &&
  thread.line !== null &&
  shown.has(thread.path)

export const toDiscussions = (
  files: ReadonlyArray<ChangedFile>,
  threads: ReadonlyArray<typeof GitHubReviewThread.Type>,
  comments: ReadonlyArray<typeof GitHubComment.Type>,
  reviews: ReadonlyArray<typeof GitHubReview.Type>,
) => {
  const shown = textDiffPaths(files)

  const onLines: Array<LineDiscussion> = []
  const outdated: Array<OutdatedDiscussion> = []

  for (const thread of threads) {
    const published = thread.comments.nodes.filter((comment) => comment.state === "SUBMITTED")

    if (!Arr.isReadonlyArrayNonEmpty(published)) continue

    const { id, path, isResolved: resolved } = thread
    const discussionComments = Arr.map(published, toComment)

    if (isOnLine(thread, shown)) {
      onLines.push(
        new LineDiscussion({
          id,
          path,
          side: fromGitHubSide(thread.diffSide),
          line: thread.line,
          resolved,
          comments: discussionComments,
        }),
      )
    } else {
      outdated.push(
        new OutdatedDiscussion({
          id,
          path,
          originalLine:
            thread.subjectType === "FILE" || thread.originalLine === null
              ? "whole-file"
              : thread.originalLine,
          diffHunk: published[0].diffHunk,
          resolved,
          comments: discussionComments,
        }),
      )
    }
  }

  const timeline: Array<PublishedComment | Review> = comments.map(toComment)

  for (const review of reviews) {
    const bodyHtml = review.bodyHTML.trim()

    if (review.state === "PENDING" || review.submittedAt === null) continue

    if (review.state === "COMMENTED" && bodyHtml === "") continue

    timeline.push(
      new Review({
        id: review.id,
        author: login(review.author),
        state: states[review.state],
        bodyHtml,
        submittedAt: review.submittedAt,
      }),
    )
  }

  return new Discussions({
    onLines,
    outdated,
    timeline: Arr.sortWith(timeline, timelineTime, DateTime.Order),
  })
}
