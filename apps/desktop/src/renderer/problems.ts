import { LOCAL_SKILLS_NAMESPACE, type TokenSource } from "@glass/contracts"
import { Cause, Match, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import type { BackendError } from "./backend"

export interface Problem {
  readonly title: string
  readonly detail: string
  readonly fixedByReload?: boolean
  readonly command?: string
}

const sourceLabel: Record<TokenSource, string> = {
  GH_TOKEN: "GH_TOKEN",
  GITHUB_TOKEN: "GITHUB_TOKEN",
  gh: "the GitHub CLI",
}

export const describeSource = (source: TokenSource) => sourceLabel[source]

export const describeError = (error: BackendError): Problem =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      SavedPlaceError: ({ message }) => ({
        title: "Couldn't remember your place",
        detail: message,
      }),
      TourFailure: ({ message }) => ({ title: "Couldn't write your Tour", detail: message }),
      AgentReviewFailure: ({ message }) => ({
        title: "Couldn't run the Agent review",
        detail: message,
      }),
      AskFailure: ({ message }) => ({ title: "Couldn't answer your question", detail: message }),
      ActivityLogError: ({ message }) => ({
        title: "Couldn't read your Activity log",
        detail: message,
      }),
      ToDoError: ({ message }) => ({
        title: "Couldn't access your to-dos",
        detail: message,
      }),
      QueueError: ({ message }) => ({
        title: "Couldn't access your Queue",
        detail: message,
      }),
      InvalidRepositoryInput: () => ({
        title: "That isn't a GitHub repository",
        detail: "Enter owner/repo or a repository URL like https://github.com/owner/repo.",
      }),
      InvalidSkillPackUrl: () => ({
        title: "That isn't a GitHub folder or repository URL",
        detail:
          "Paste a URL like https://github.com/owner/repo or https://github.com/owner/repo/tree/main/skills.",
      }),
      SkillPackNotReadable: ({ message }) => ({
        title: "Couldn't read that Skill pack",
        detail: message,
      }),
      InvalidSkillPackName: () => ({
        title: "That name can't be a Skill pack's",
        detail: `Use lowercase letters, digits, and single hyphens, up to 64 characters. ${LOCAL_SKILLS_NAMESPACE} is kept for your Local skills.`,
      }),
      SkillPackNameTaken: ({ name }) => ({
        title: "That name is taken",
        detail: `You already have a Skill pack named ${name}. Choose another name.`,
      }),
      SkillPackNotFound: ({ name }) => ({
        title: "This Skill pack is gone",
        detail: `${name} was removed. Reload Settings to see your Skill packs now.`,
      }),
      SkillPackError: ({ message }) => ({ title: "Couldn't access Skill packs", detail: message }),
      LocalSkillsError: ({ message }) => ({
        title: "Couldn't read your Local skills",
        detail: message,
      }),
      StorageError: () => ({
        title: "Couldn't measure storage",
        detail: "Glass couldn't read its database sizes.",
      }),
      SettingsError: ({ message }) => ({
        title: "Couldn't access settings",
        detail: message,
      }),
      NoCredentials: () => ({
        title: "No GitHub credentials found",
        detail:
          "Run `gh auth login`, then try again. Glass reads GH_TOKEN and GITHUB_TOKEN only when it starts, so relaunch after setting one.",
        command: "gh auth login",
      }),
      TokenRejected: ({ tokenSource }) =>
        tokenSource === "gh"
          ? {
              title: "GitHub rejected your token",
              detail:
                "The token from the GitHub CLI is invalid or expired. Run `gh auth login`, then try again.",
              command: "gh auth login",
            }
          : {
              title: "GitHub rejected your token",
              detail: `The token from ${describeSource(tokenSource)} is invalid or expired. Replace it, then relaunch Glass.`,
            },
      GitHubUnavailable: ({ message }) => ({ title: "Couldn't reach GitHub", detail: message }),
      PullRequestNotFound: ({ ref: { owner, repo, number } }) => ({
        title: "Pull request not found",
        detail: `${owner}/${repo}#${number} doesn't exist, or your GitHub token can't see it.`,
      }),
      PullRequestAccessDenied: ({ ref, message }) => ({
        title: `GitHub denied access to ${ref.owner}/${ref.repo}`,
        detail: message,
      }),
      FileNotFound: ({ path, side }) => ({
        title: `${path} isn't in this revision`,
        detail: `The pull request's ${side} has no file at that path.`,
      }),
      StaleRevision: () => ({
        title: "The pull request has new commits",
        detail: "Its lines may have moved since you opened it. Reload to review it as it is now.",
        fixedByReload: true,
      }),
      DraftNotFound: () => ({
        title: "This Draft is gone from GitHub",
        detail:
          "It was deleted, or its Review submitted, elsewhere. Reload to see your Drafts now.",
        fixedByReload: true,
      }),
      ReviewRejected: ({ message }) => ({
        title: "GitHub didn't accept the Review",
        detail: message === "" ? "GitHub didn't say why." : message,
      }),
      CommentNotFound: () => ({
        title: "This comment is gone from GitHub",
        detail: "It was deleted. Reload to see the Discussion as it is now.",
        fixedByReload: true,
      }),
      DiscussionNotFound: () => ({
        title: "This Discussion is gone from GitHub",
        detail:
          "Its comments were deleted. Reloading drops this Reply, so copy its text first if you want it.",
      }),
      DraftsBlockReply: () => ({
        title: "GitHub won't publish a Reply while you have Drafts",
        detail:
          "It would hold the Reply until your Review is submitted. Submit or delete your Drafts, then retry.",
      }),
      AgentError: ({ message }) => ({ title: "Couldn't reach your Agents", detail: message }),
      AgentNotFound: () => ({
        title: "This Agent is gone",
        detail: "It was removed. Pick another Agent or start a new one.",
      }),
      AgentBusy: () => ({
        title: "The Agent is still working",
        detail: "Wait for its Turn to end, then send your message.",
      }),
      RequestWaiting: () => ({
        title: "The Agent is waiting on you",
        detail: "Answer its Permission request or Question, then send your message.",
      }),
      QueuedMessageStarted: () => ({
        title: "Too late to cancel",
        detail: "That message already started a Turn, so it stays in the conversation.",
      }),
      RequestNotWaiting: () => ({
        title: "Already settled",
        detail: "That request was answered already, or its Turn ended.",
      }),
      OutsideQuestionNotWaiting: () => ({
        title: "Already settled",
        detail: "That question was answered already, or the wait ended.",
      }),
      OutsideAgentNotFound: () => ({
        title: "That agent is already disconnected",
        detail: "It is no longer in the list of connected outside agents.",
      }),
      NoPermissionModes: () => ({
        title: "No Permission modes",
        detail: "This Agent's program doesn't take a Permission mode.",
      }),
      InvalidLocalCheckout: ({ message }) => ({
        title: "Glass can't use that folder",
        detail: message,
      }),
      RpcClientError: () => ({
        title: "Couldn't reach the Glass backend",
        detail: "Glass reconnects on its own. Try again in a moment.",
      }),
    }),
  )

export const problemText = (problem: Problem) => `${problem.title}. ${problem.detail}`

export const unexpectedProblem: Problem = {
  title: "Something went wrong in Glass",
  detail: "Try again. If this keeps happening, check the app logs.",
}

export const problemOf = (cause: Cause.Cause<BackendError>): Problem =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: describeError,
    onNone: () => unexpectedProblem,
  })

export const describeStreamError = (error: BackendError | Cause.NoSuchElementError) =>
  Predicate.isTagged(error, "NoSuchElementError") ? unexpectedProblem : describeError(error)

export const streamProblem = (
  cause: Cause.Cause<BackendError | Cause.NoSuchElementError>,
): Problem =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: describeStreamError,
    onNone: () => unexpectedProblem,
  })

export const settledProblem = (result: AsyncResult.AsyncResult<unknown, BackendError>) =>
  AsyncResult.isFailure(result) && !result.waiting ? problemOf(result.cause) : null
