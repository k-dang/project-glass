import {
  type Activity,
  ActivityPullRequest,
  FileViewed,
  type PullRequestWorkspace,
} from "@glass/contracts"
import { Backend, type BackendRuntime } from "./backend"

const VIEW_DELAY_MS = 2000

export const activityPullRequest = ({ pullRequest, revision }: PullRequestWorkspace) =>
  new ActivityPullRequest({ ref: pullRequest.ref, title: pullRequest.title, revision })

export class ActivityRecorder {
  readonly #pullRequest: ActivityPullRequest
  readonly #runtime: BackendRuntime
  readonly #viewed = new Set<string>()

  constructor(workspace: PullRequestWorkspace, runtime: BackendRuntime) {
    this.#pullRequest = activityPullRequest(workspace)
    this.#runtime = runtime
  }

  readonly record = (activity: Activity) => {
    void this.#runtime.runPromiseExit(Backend.use((backend) => backend.RecordActivity(activity)))
  }

  view(path: string) {
    if (this.#viewed.has(path)) return () => {}

    const viewing = setTimeout(() => {
      this.#viewed.add(path)
      this.record(FileViewed.make({ pullRequest: this.#pullRequest, path }))
    }, VIEW_DELAY_MS)

    return () => clearTimeout(viewing)
  }
}
