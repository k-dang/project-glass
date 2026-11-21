import {
  type ChangedFile,
  PublishedComments,
  LineReviewThread,
  OutdatedReviewThread,
  PublishedComment,
  Review,
  type ReviewState,
} from "@glass/contracts"
import { Array as Arr, DateTime, Predicate, Schema } from "effect"
import { avatarUrl, GitHubAuthor, login } from "./author"
import { fromGitHubSide, GitHubDiffSide } from "./diffSide"
import { GitHubReactionGroups, REACTION_GROUPS, toReactionGroups } from "./reactions"

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
            nodes { id author { login avatarUrl(size: 48) } body bodyHTML createdAt state diffHunk ${REACTION_GROUPS} }
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
        nodes { id author { login avatarUrl(size: 48) } bodyHTML createdAt ${REACTION_GROUPS} }
      }
    }
  }
}`

export const RESOLVE_REVIEW_THREAD_MUTATION = `mutation ResolveReviewThread($reviewThreadId: ID!) {
  resolveReviewThread(input: { threadId: $reviewThreadId }) { thread { isResolved } }
}`

export const UNRESOLVE_REVIEW_THREAD_MUTATION = `mutation UnresolveReviewThread($reviewThreadId: ID!) {
  unresolveReviewThread(input: { threadId: $reviewThreadId }) { thread { isResolved } }
}`

const ResolvedReviewThread = Schema.Struct({
  thread: Schema.NullOr(Schema.Struct({ isResolved: Schema.Boolean })),
})

export const ReviewThreadResolution = Schema.Struct({
  resolveReviewThread: Schema.optional(Schema.NullOr(ResolvedReviewThread)),
  unresolveReviewThread: Schema.optional(Schema.NullOr(ResolvedReviewThread)),
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
        reactionGroups: Schema.NullOr(GitHubReactionGroups),
      }),
    ),
  }),
})

export const GitHubComment = Schema.Struct({
  id: Schema.String,
  author: GitHubAuthor,
  bodyHTML: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  reactionGroups: Schema.NullOr(GitHubReactionGroups),
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
    reactions: toReactionGroups(comment.reactionGroups ?? []),
  })

const timelineTime = (item: PublishedComment | Review) =>
  item instanceof Review ? item.submittedAt : item.createdAt

export const textDiffPaths = (files: ReadonlyArray<ChangedFile>): ReadonlySet<string> =>
  new Set(files.flatMap((file) => (Predicate.isTagged(file.patch, "TextPatch") ? [file.path] : [])))

export const isOnLine = (
  reviewThread: typeof GitHubReviewThread.Type,
  shown: ReadonlySet<string>,
): reviewThread is typeof GitHubReviewThread.Type & { readonly line: number } =>
  reviewThread.subjectType === "LINE" &&
  !reviewThread.isOutdated &&
  reviewThread.line !== null &&
  shown.has(reviewThread.path)

export const toPublishedComments = (
  files: ReadonlyArray<ChangedFile>,
  reviewThreads: ReadonlyArray<typeof GitHubReviewThread.Type>,
  prComments: ReadonlyArray<typeof GitHubComment.Type>,
  reviews: ReadonlyArray<typeof GitHubReview.Type>,
) => {
  const shown = textDiffPaths(files)

  const onLines: Array<LineReviewThread> = []
  const outdated: Array<OutdatedReviewThread> = []

  for (const reviewThread of reviewThreads) {
    const published = reviewThread.comments.nodes.filter((comment) => comment.state === "SUBMITTED")

    if (!Arr.isReadonlyArrayNonEmpty(published)) continue

    const { id, path, isResolved: resolved } = reviewThread
    const comments = Arr.map(published, toComment)

    if (isOnLine(reviewThread, shown)) {
      onLines.push(
        new LineReviewThread({
          id,
          path,
          side: fromGitHubSide(reviewThread.diffSide),
          line: reviewThread.line,
          resolved,
          comments,
        }),
      )
    } else {
      outdated.push(
        new OutdatedReviewThread({
          id,
          path,
          originalLine:
            reviewThread.subjectType === "FILE" || reviewThread.originalLine === null
              ? "whole-file"
              : reviewThread.originalLine,
          diffHunk: published[0].diffHunk,
          resolved,
          comments,
        }),
      )
    }
  }

  const timeline: Array<PublishedComment | Review> = prComments.map(toComment)

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

  return new PublishedComments({
    onLines,
    outdated,
    timeline: Arr.sortWith(timeline, timelineTime, DateTime.Order),
  })
}
