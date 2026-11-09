import { CapturedContext, PullRequestContext, PullRequestRef } from "@glass/contracts"
import { Schema } from "effect"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vite-plus/test"
import { dogfoodReportWriter, slugOf } from "./dogfoodReports"

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "glass-dogfood-reports-"))
})

afterEach(() => rm(home, { recursive: true, force: true }))

const revision = { base: "base-sha", head: "head-sha" }

const context = Schema.encodeSync(CapturedContext)(
  PullRequestContext.make({
    pullRequest: new PullRequestRef({ owner: "octo-org", repo: "glass", number: 42 }),
    revision,
  }),
)

const noSubject = { route: "/agents/new", context: null, tour: null, agentReview: null }

const record = async () => {
  await writeFile(join(home, "backend.log"), '{"unit":"tour"}\n')

  const writer = dogfoodReportWriter(join(home, "reports"))

  const id = await writer.record({
    screenshot: Buffer.from("png"),
    backendLogPath: join(home, "backend.log"),
    settingsPath: join(home, "settings.json"),
    glassCommit: "86aa4de-dirty",
    now: new Date(2026, 10, 9, 14, 32, 5),
  })

  return { writer, id }
}

it("keeps the logs as they were when captured, and names the report after its note", async () => {
  const { writer, id } = await record()
  await writeFile(join(home, "backend.log"), '{"unit":"later"}\n')

  const folder = await writer.finish({
    id,
    note: "Tour overview is too long\nIt wraps past the fold.",
    subject: {
      route: "/reviews/octo-org/glass/42",
      context,
      tour: null,
      agentReview: {
        revision,
        writtenAt: "2026-11-09T14:00:00.000Z",
        markdown: "# Main risk",
        agentId: null,
      },
    },
  })

  expect(basename(folder)).toBe("2026-11-09-143205-tour-overview-is-too-long")
  expect((await readdir(folder)).toSorted()).toEqual([
    "agent-review.md",
    "backend.log",
    "note.md",
    "screenshot.png",
    "subject.json",
  ])
  expect(await readFile(join(folder, "backend.log"), "utf8")).toBe('{"unit":"tour"}\n')
  expect(JSON.parse(await readFile(join(folder, "subject.json"), "utf8"))).toEqual({
    recordedAt: new Date(2026, 10, 9, 14, 32, 5).toISOString(),
    glassCommit: "86aa4de-dirty",
    route: "/reviews/octo-org/glass/42",
    context,
    agentReview: { revision, writtenAt: "2026-11-09T14:00:00.000Z", agentId: null },
  })
})

it("keeps a report without a note under its time alone, and finishes it only once", async () => {
  const { writer, id } = await record()
  const details = { id, note: "  ", subject: noSubject }

  expect(basename(await writer.finish(details))).toBe("2026-11-09-143205")
  await expect(writer.finish(details)).rejects.toThrow("No unfinished Dogfood report")
})

it("writes nothing for a discarded report", async () => {
  const { writer, id } = await record()

  writer.discard(id)

  await expect(writer.finish({ id, note: "", subject: noSubject })).rejects.toThrow(
    "No unfinished Dogfood report",
  )
  expect(await readdir(home)).toEqual(["backend.log"])
})

it("refuses a second report with the same name rather than overwriting the first", async () => {
  const { writer, id } = await record()
  const folder = await writer.finish({ id, note: "", subject: noSubject })

  const later = await writer.record({
    screenshot: Buffer.from("later"),
    backendLogPath: join(home, "backend.log"),
    settingsPath: join(home, "settings.json"),
    glassCommit: "86aa4de",
    now: new Date(2026, 10, 9, 14, 32, 5),
  })

  await expect(writer.finish({ id: later, note: "", subject: noSubject })).rejects.toThrow("EEXIST")
  expect(await readFile(join(folder, "screenshot.png"), "utf8")).toBe("png")
})

it("slugs the note's first line", () => {
  expect(slugOf("  Can't read the Before / after!  \nmore")).toBe("can-t-read-the-before-after")
  expect(slugOf("Tour overview text is too long to read at a glance")).toBe(
    "tour-overview-text-is-too-long-to-read-at-a",
  )
  expect(slugOf("")).toBe("")
})
