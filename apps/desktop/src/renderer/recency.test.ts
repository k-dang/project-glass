import { expect, it } from "vite-plus/test"
import { dayOf, recencyOf } from "./recency"

const now = new Date(2026, 9, 20, 0, 30)

it("buckets by local calendar day rather than elapsed hours", () => {
  expect(recencyOf(new Date(2026, 9, 20, 0, 5), now)).toBe("Today")
  expect(recencyOf(new Date(2026, 9, 19, 23, 50), now)).toBe("Yesterday")
  expect(recencyOf(new Date(2026, 9, 18, 0, 0), now)).toBe("Past week")
  expect(recencyOf(new Date(2026, 9, 14, 23, 59), now)).toBe("Past week")
  expect(recencyOf(new Date(2026, 9, 13, 23, 59), now)).toBe("Older")
})

it("treats clock skew into the future as today", () => {
  expect(recencyOf(new Date(2026, 9, 21, 9, 0), now)).toBe("Today")
})

it("names each local calendar day, with the year only outside this one", () => {
  expect(dayOf(new Date(2026, 9, 20, 0, 5), now)).toBe("Today")
  expect(dayOf(new Date(2026, 9, 19, 23, 50), now)).toBe("Yesterday")
  expect(dayOf(new Date(2026, 9, 18, 12, 0), now)).toContain("18")
  expect(dayOf(new Date(2026, 9, 18, 12, 0), now)).not.toContain("2026")
  expect(dayOf(new Date(2025, 11, 31, 12, 0), now)).toContain("2025")
})
