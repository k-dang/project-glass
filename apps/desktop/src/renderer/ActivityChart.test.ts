import { ActivityStamp } from "@glass/contracts"
import { DateTime } from "effect"
import { expect, it } from "vite-plus/test"
import { activityByDay } from "./ActivityChart"

const stamp = (kind: ActivityStamp["kind"], at: Date) =>
  new ActivityStamp({ kind, occurredAt: DateTime.fromDateUnsafe(at) })

it("counts each kind on the local day it happened, for the days ending today", () => {
  const now = new Date(2026, 10, 4, 15, 30)

  const days = activityByDay(
    [
      stamp("ReplySent", new Date(2026, 10, 1, 23, 59)),
      stamp("ReplySent", new Date(2026, 10, 2, 0, 0)),
      stamp("ReviewSubmitted", new Date(2026, 10, 2, 0, 0)),
      stamp("ToDoDone", new Date(2026, 10, 4, 15, 0)),
      stamp("AgentStarted", new Date(2026, 9, 31, 12, 0)),
    ],
    4,
    now,
  )

  expect(
    days.map(({ ReviewSubmitted, ReplySent, AgentStarted, ToDoDone }) => [
      ReviewSubmitted,
      ReplySent,
      AgentStarted,
      ToDoDone,
    ]),
  ).toEqual([
    [0, 1, 0, 0],
    [1, 1, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 1],
  ])
})
