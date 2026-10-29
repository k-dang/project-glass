import type { StatusState } from "../src/github/repositoryPullRequests"

export const VIEWER = {
  id: 1,
  login: "octocat",
  token: "valid-github-token",
  teams: ["octo-org/reviewers"],
} as const

export interface FakeCommit {
  readonly sha: string
  readonly files: Readonly<Record<string, string>>
}

export interface FakeLine {
  readonly path: string
  readonly line: number
  readonly side: "LEFT" | "RIGHT"
}

export interface FakeDraft extends FakeLine {
  readonly id: string
  readonly body: string
  readonly diffHunk: string
  readonly outdated: boolean
}

export interface FakeComment {
  readonly id: string
  readonly author: string | null
  readonly bodyHtml: string
  readonly createdAt: string
}

export interface FakeReviewThread {
  readonly id: string
  readonly path: string
  readonly line?: number
  readonly side: "LEFT" | "RIGHT"
  readonly diffHunk: string
  readonly outdated: boolean
  readonly resolved: boolean
  readonly comments: ReadonlyArray<FakeComment>
}

export type FakeReviewState = "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED"

export interface FakeReview {
  readonly id: string
  readonly author: string | null
  readonly state: FakeReviewState
  readonly bodyHtml: string
  readonly submittedAt: string
}

export type FakeCommentSeed = Omit<FakeComment, "id" | "createdAt">

export interface FakeChangedFile {
  readonly path: string
  readonly status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed"
  readonly previousPath?: string
  readonly additions?: number
  readonly deletions?: number
  readonly patch?: string
  readonly viewerViewedState?: "VIEWED" | "UNVIEWED" | "DISMISSED"
}

export type FakePullRequestState = "OPEN" | "CLOSED" | "MERGED"

type FakeChecks = typeof StatusState.Type

export type FakeCheck =
  | {
      readonly kind: "CheckRun"
      readonly name: string
      readonly workflow?: string
      readonly status?: "QUEUED" | "IN_PROGRESS" | "COMPLETED"
      readonly conclusion?: string
      readonly url?: string
    }
  | {
      readonly kind: "StatusContext"
      readonly context: string
      readonly state: FakeChecks
      readonly url?: string
    }

export type FakeReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED"

export type FakeMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN"

export interface FakePullRequestSeed {
  readonly owner?: string
  readonly repo?: string
  readonly number?: number
  readonly title?: string
  readonly author?: string | null
  readonly baseBranch?: string
  readonly headBranch?: string
  readonly state?: FakePullRequestState
  readonly isDraft?: boolean
  readonly bodyHtml?: string
  readonly body?: string
  readonly requestedReviewers?: ReadonlyArray<string>
  readonly requestedTeams?: ReadonlyArray<string>
  readonly checks?: FakeChecks
  readonly checkContexts?: ReadonlyArray<FakeCheck>
  readonly reviewDecision?: FakeReviewDecision
  readonly mergeable?: FakeMergeable
  readonly updatedAt?: string
  readonly base: FakeCommit
  readonly head: FakeCommit
  readonly changedFiles?: ReadonlyArray<FakeChangedFile>
  readonly pendingReview?: {
    readonly drafts: ReadonlyArray<Omit<FakeDraft, "id" | "outdated">>
  }
}

export interface FakePush {
  readonly head?: FakeCommit
  readonly base?: FakeCommit
  readonly changedFiles?: ReadonlyArray<FakeChangedFile>
  readonly outdatedDrafts?: ReadonlyArray<string>
  readonly outdatedThreads?: ReadonlyArray<string>
}

export interface PullRequestCommits {
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly base: FakeCommit
  readonly head: FakeCommit
}

export type PublishCommits = (
  commits: PullRequestCommits,
) => Pick<PullRequestCommits, "base" | "head">

export class FakePullRequest {
  readonly id: string
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly title: string
  readonly author: string | null
  readonly baseBranch: string
  readonly headBranch: string
  readonly bodyHtml: string
  readonly body: string
  readonly requestedReviewers: Set<string>
  readonly requestedTeams: Set<string>
  checks: FakeChecks | null
  checkContexts: ReadonlyArray<FakeCheck>
  reviewDecision: FakeReviewDecision | null
  mergeable: FakeMergeable
  #state: FakePullRequestState
  #isDraft: boolean
  #updatedAt: string
  #base: FakeCommit
  #head: FakeCommit
  #changedFiles: ReadonlyArray<FakeChangedFile>
  readonly commits = new Map<string, FakeCommit>()
  pendingReview: { readonly id: string; readonly drafts: Array<FakeDraft> } | undefined
  readonly reviewThreads: Array<FakeReviewThread> = []
  readonly comments: Array<FakeComment> = []
  readonly reviews: Array<FakeReview> = []
  readonly viewedPaths = new Set<string>()
  private readonly publishCommits: PublishCommits
  private readonly nextId: (prefix: string) => string
  private readonly now: () => string

  constructor(
    nextId: (prefix: string) => string,
    now: () => string,
    seed: FakePullRequestSeed,
    nextNumber: (owner: string, repo: string) => number,
    publishCommits: PublishCommits = (commits) => commits,
  ) {
    this.publishCommits = publishCommits
    this.nextId = nextId
    this.now = now
    this.id = nextId("PR")
    this.owner = seed.owner ?? "octo-org"
    this.repo = seed.repo ?? "hello-world"
    this.number = seed.number ?? nextNumber(this.owner, this.repo)
    this.title = seed.title ?? "Add a greeting"
    this.author = seed.author === undefined ? "hubot" : seed.author
    this.baseBranch = seed.baseBranch ?? "main"
    this.headBranch = seed.headBranch ?? "greeting"
    this.#state = seed.state ?? "OPEN"
    this.#isDraft = seed.isDraft ?? false
    this.bodyHtml = seed.bodyHtml ?? ""
    this.body = seed.body ?? ""
    this.requestedReviewers = new Set(seed.requestedReviewers)
    this.requestedTeams = new Set(seed.requestedTeams)
    this.checks = seed.checks ?? null
    this.checkContexts = seed.checkContexts ?? []
    this.reviewDecision = seed.reviewDecision ?? null
    this.mergeable = seed.mergeable ?? "MERGEABLE"
    this.#updatedAt = seed.updatedAt ?? now()
    this.#base = seed.base
    this.#head = seed.head
    this.publishHead(seed)
    this.#changedFiles = seed.changedFiles ?? []

    for (const file of this.#changedFiles) {
      if (file.viewerViewedState === "VIEWED") this.viewedPaths.add(file.path)
    }

    this.pendingReview =
      seed.pendingReview === undefined ? undefined : { id: nextId("PRR"), drafts: [] }

    for (const draft of seed.pendingReview?.drafts ?? []) this.addDraft(draft)
  }

  get url(): string {
    return `https://github.com/${this.owner}/${this.repo}/pull/${this.number}`
  }

  get base(): FakeCommit {
    return this.#base
  }

  get head(): FakeCommit {
    return this.#head
  }

  get changedFiles(): ReadonlyArray<FakeChangedFile> {
    return this.#changedFiles
  }

  push(change: FakePush): void {
    const drafts = this.pendingReview?.drafts ?? []
    const outdatedDrafts = new Set(change.outdatedDrafts)
    const outdatedThreads = new Set(change.outdatedThreads)
    requireKnown(
      "Draft",
      outdatedDrafts,
      drafts.map((draft) => draft.id),
    )
    requireKnown(
      "review thread",
      outdatedThreads,
      this.reviewThreads.map((thread) => thread.id),
    )

    this.publishHead({ base: change.base ?? this.#base, head: change.head ?? this.#head })

    this.#changedFiles = change.changedFiles ?? this.#changedFiles

    for (const [index, draft] of drafts.entries()) {
      if (outdatedDrafts.has(draft.id)) drafts[index] = { ...draft, outdated: true }
    }

    for (const [index, thread] of this.reviewThreads.entries()) {
      if (outdatedThreads.has(thread.id)) this.reviewThreads[index] = { ...thread, outdated: true }
    }
  }

  addReviewThread(thread: {
    readonly path: string
    readonly line?: number
    readonly side?: "LEFT" | "RIGHT"
    readonly diffHunk?: string
    readonly resolved?: boolean
    readonly comments: ReadonlyArray<FakeCommentSeed>
  }): FakeReviewThread {
    const { comments, ...location } = thread

    const added: FakeReviewThread = {
      side: "RIGHT",
      diffHunk: "",
      resolved: false,
      ...location,
      id: this.nextId("PRRT"),
      outdated: false,
      comments: comments.map((comment) => this.publish("PRRC", comment)),
    }

    this.reviewThreads.push(added)

    return added
  }

  addComment(comment: FakeCommentSeed): FakeComment {
    const added = this.publish("IC", comment)
    this.comments.push(added)

    return added
  }

  get state(): FakePullRequestState {
    return this.#state
  }

  get isDraft(): boolean {
    return this.#isDraft
  }

  get updatedAt(): string {
    return this.#updatedAt
  }

  edit(changes: { readonly state?: FakePullRequestState; readonly isDraft?: boolean }): void {
    this.#state = changes.state ?? this.#state
    this.#isDraft = changes.isDraft ?? this.#isDraft
    this.#updatedAt = this.now()
  }

  requestReview(login: string): void {
    this.requestedReviewers.add(login)
    this.#updatedAt = this.now()
  }

  addReview(review: {
    readonly author: string | null
    readonly state: FakeReviewState
    readonly bodyHtml?: string
  }): FakeReview {
    const added: FakeReview = {
      bodyHtml: "",
      ...review,
      id: this.nextId("PRR"),
      submittedAt: this.now(),
    }

    this.reviews.push(added)
    this.#updatedAt = added.submittedAt

    if (review.author !== null) this.requestedReviewers.delete(review.author)

    return added
  }

  addDraft(draft: Omit<FakeDraft, "id" | "outdated">): FakeDraft {
    const added: FakeDraft = {
      ...draft,
      id: this.nextId("PRRC"),
      outdated: false,
    }

    this.pendingReview ??= { id: this.nextId("PRR"), drafts: [] }
    this.pendingReview.drafts.push(added)

    return added
  }

  reply(
    threadId: string,
    body: string,
  ): { readonly comment: FakeComment; readonly pending: boolean } | undefined {
    const index = this.reviewThreads.findIndex((thread) => thread.id === threadId)

    if (index === -1) return undefined

    const thread = this.reviewThreads[index]!

    if (this.pendingReview !== undefined) {
      const { path, line = 1, side, diffHunk } = thread
      const held = this.addDraft({ path, line, side, diffHunk, body })

      return {
        comment: {
          id: held.id,
          author: VIEWER.login,
          bodyHtml: `<p>${body}</p>`,
          createdAt: this.now(),
        },
        pending: true,
      }
    }

    const comment = this.publish("PRRC", { author: VIEWER.login, bodyHtml: `<p>${body}</p>` })
    this.reviewThreads[index] = { ...thread, comments: [...thread.comments, comment] }
    this.addReview({ author: VIEWER.login, state: "COMMENTED" })

    return { comment, pending: false }
  }

  setResolved(threadId: string, resolved: boolean): boolean | undefined {
    const index = this.reviewThreads.findIndex((thread) => thread.id === threadId)

    if (index === -1) return undefined

    this.reviewThreads[index] = { ...this.reviewThreads[index]!, resolved }

    return resolved
  }

  submitPendingReview(state: FakeReviewState = "COMMENTED", bodyHtml = ""): void {
    for (const { id, path, line, side, diffHunk, outdated, body } of this.pendingReview?.drafts ??
      []) {
      this.reviewThreads.push({
        id: this.nextId("PRRT"),
        path,
        line,
        side,
        diffHunk,
        outdated,
        resolved: false,
        comments: [{ id, author: VIEWER.login, bodyHtml: `<p>${body}</p>`, createdAt: this.now() }],
      })
    }

    this.pendingReview = undefined
    this.addReview({ author: VIEWER.login, state, bodyHtml })
  }

  private publishHead({ base, head }: { readonly base: FakeCommit; readonly head: FakeCommit }) {
    const published = this.publishCommits({
      owner: this.owner,
      repo: this.repo,
      number: this.number,
      base,
      head,
    })

    this.#base = published.base
    this.#head = published.head
    this.commits.set(published.base.sha, published.base)
    this.commits.set(published.head.sha, published.head)
  }

  private publish(prefix: string, comment: FakeCommentSeed): FakeComment {
    return { ...comment, id: this.nextId(prefix), createdAt: this.now() }
  }
}

const requireKnown = (label: string, named: Iterable<string>, known: ReadonlyArray<string>) => {
  for (const name of named) {
    if (!known.includes(name)) throw new Error(`No ${label} ${name}`)
  }
}
