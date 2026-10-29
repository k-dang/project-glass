import type { PullRequestWorkspace, ReviewDestination, ReviewPosition } from "@glass/contracts"
import { referenceKey } from "@glass/contracts"
import { Equal } from "effect"
import type { WorkspaceView } from "./reviewsArea"

export const positionOf = (view: WorkspaceView): ReviewPosition => {
  if (view.tab === "overview") return { tab: "overview" }

  if (view.tab === "changes") return { tab: "changes", file: view.file, order: view.order }

  return { tab: "files", file: view.repositoryFile }
}

export const restoreReviewPosition = (
  workspace: PullRequestWorkspace,
  destination: ReviewDestination,
) => {
  if (
    workspace.viewer.login.toLowerCase() !== destination.login.toLowerCase() ||
    referenceKey(workspace.pullRequest.ref) !== referenceKey(destination.pullRequest)
  ) {
    return { view: null, notice: null }
  }

  if (!Equal.equals(workspace.revision, destination.revision)) {
    return {
      view: null,
      notice: "This PR changed since you last read it. Opened Overview at its current Revision.",
    }
  }

  const { position } = destination

  const view: WorkspaceView = {
    tab: position.tab,
    file: null,
    repositoryFile: null,
    order: "tour",
  }

  if (position.tab === "overview") return { view, notice: null }

  if (position.tab === "changes") {
    const exists =
      position.file === null || workspace.files.some(({ path }) => path === position.file)

    return {
      view: { ...view, file: exists ? position.file : null, order: position.order },
      notice: exists ? null : "The saved file isn't in this diff. Opened Changes from the start.",
    }
  }

  return { view: { ...view, repositoryFile: position.file }, notice: null }
}
