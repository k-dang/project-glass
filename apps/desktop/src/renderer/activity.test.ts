import { type Activity, FileViewed } from "@glass/contracts"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { ActivityRecorder } from "./activity"
import { testRuntime } from "../../test/testBackend"
import { recordedPullRequest, workspace } from "../../test/workspace"

const recorder = () => {
  const recorded: Array<Activity> = []

  const RecordActivity = (activity: Activity) =>
    Effect.sync(() => {
      recorded.push(activity)
    })

  const activity = new ActivityRecorder(workspace(), testRuntime({ RecordActivity }))

  return { activity, recorded }
}

const viewFor = (activity: ActivityRecorder, path: string, ms: number) => {
  const leave = activity.view(path)
  vi.advanceTimersByTime(ms)
  leave()
}

const viewed = (path: string) => FileViewed.make({ pullRequest: recordedPullRequest, path })

describe("ActivityRecorder", () => {
  beforeEach(() => {
    // Only the viewing delay's timers; Effect schedules its fibers with setImmediate.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("records only files viewed for two seconds, even after leaving and waiting", async () => {
    const { activity, recorded } = recorder()

    viewFor(activity, "a.ts", 500)
    viewFor(activity, "b.ts", 1999)
    viewFor(activity, "c.ts", 2000)
    viewFor(activity, "d.ts", 1999)
    viewFor(activity, "e.ts", 1000)
    vi.advanceTimersByTime(5000)

    await eventually(() => expect(recorded).toEqual([viewed("c.ts")]))
  })

  it("records each file as viewed once per workspace load", async () => {
    const { activity, recorded } = recorder()

    viewFor(activity, "a.ts", 2000)
    viewFor(activity, "b.ts", 2000)
    viewFor(activity, "a.ts", 2000)
    viewFor(activity, "c.ts", 2000)

    await eventually(() =>
      expect(recorded).toEqual([viewed("a.ts"), viewed("b.ts"), viewed("c.ts")]),
    )
  })
})
