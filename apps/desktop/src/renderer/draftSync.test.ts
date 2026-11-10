import { FlaggedPlace, LinePlace } from "@glass/contracts"
import { expect, it } from "vite-plus/test"
import { type DraftEntry, draftView, stepDraft } from "./draftSync"

const local: DraftEntry = {
  key: "new-1",
  path: "greet.ts",
  place: LinePlace.make({ side: "new", line: 2 }),
  body: "First",
  saved: null,
  intent: "edit",
  sync: { type: "idle" },
}

const saved: DraftEntry = { ...local, saved: { id: "D1", body: "Original" } }

const problem = { title: "Couldn't save", detail: "GitHub is unavailable" }

it("coalesces Save requests into the latest text without overlapping writes", () => {
  const first = stepDraft(local, { type: "save" })
  const edited = stepDraft(first.entry!, { type: "edit", body: "Second" })
  const requested = stepDraft(edited.entry!, { type: "save" })
  const latest = stepDraft(requested.entry!, { type: "edit", body: "Latest" })

  expect(first.write).toMatchObject({ type: "create", body: "First" })
  expect([edited.write, requested.write, latest.write]).toEqual([null, null, null])

  const next = stepDraft(latest.entry!, {
    type: "saved",
    saved: { id: "D1", body: "First" },
  })

  expect(next.write).toEqual({ type: "update", id: "D1", body: "Latest" })
  expect(next.entry?.intent).toBe("edit")
})

it("leaves an edit unsaved when no Save was requested during the write", () => {
  const writing = stepDraft(local, { type: "save" })
  const edited = stepDraft(writing.entry!, { type: "edit", body: "Still editing" })

  const settled = stepDraft(edited.entry!, {
    type: "saved",
    saved: { id: "D1", body: "First" },
  })

  expect(settled.write).toBeNull()
  expect(draftView(settled.entry!)).toMatchObject({
    body: "Still editing",
    feedback: { type: "unsaved" },
  })
})

it("drops a local Draft removed during a failed creation without another call", () => {
  const writing = stepDraft(local, { type: "save" })
  const removing = stepDraft(writing.entry!, { type: "remove" })
  const settled = stepDraft(removing.entry!, { type: "failed", problem })

  expect(removing.write).toBeNull()
  expect(settled).toEqual({ entry: null, write: null })
})

it("deletes the confirmed Draft after an update fails while removal is requested", () => {
  const writing = stepDraft(saved, { type: "save" })
  const removing = stepDraft(writing.entry!, { type: "remove" })
  const settled = stepDraft(removing.entry!, { type: "failed", problem })

  expect(removing.write).toBeNull()
  expect(settled.write).toEqual({ type: "delete", id: "D1" })
  expect(draftView(settled.entry!)).toMatchObject({
    deleting: true,
    feedback: { type: "sending", action: "delete" },
  })
})

it("keeps a failed deletion until an explicit retry, then removes the Draft", () => {
  const removing = stepDraft(saved, { type: "remove" })
  const failed = stepDraft(removing.entry!, { type: "failed", problem })

  expect(failed.write).toBeNull()
  expect(draftView(failed.entry!)).toMatchObject({
    deleting: true,
    feedback: { type: "failed", action: "delete", problem },
  })

  const retry = stepDraft(failed.entry!, { type: "save" })

  expect(retry.write).toEqual({ type: "delete", id: "D1" })
  expect(stepDraft(retry.entry!, { type: "saved", saved: null })).toEqual({
    entry: null,
    write: null,
  })
})

it("creates the latest text after clearing a saved Draft and retyping during deletion", () => {
  const cleared = stepDraft(saved, { type: "edit", body: "" })
  const deleting = stepDraft(cleared.entry!, { type: "save" })
  const retyped = stepDraft(deleting.entry!, { type: "edit", body: "Replacement" })
  const requested = stepDraft(retyped.entry!, { type: "save" })

  expect(deleting.write).toEqual({ type: "delete", id: "D1" })
  expect(requested.write).toBeNull()
  expect(stepDraft(requested.entry!, { type: "saved", saved: null }).write).toEqual({
    type: "create",
    path: "greet.ts",
    side: "new",
    line: 2,
    body: "Replacement",
  })
})

it("retains a missing Flagged draft's text without recreating it on an invalid line", () => {
  const flagged: DraftEntry = {
    ...saved,
    place: FlaggedPlace.make({ originalLine: 2, diffHunk: "" }),
  }

  const writing = stepDraft(flagged, { type: "save" })
  const missing = stepDraft(writing.entry!, { type: "missing" })

  expect(writing.write).toEqual({ type: "update", id: "D1", body: "First" })
  expect(missing.write).toBeNull()
  expect(draftView(missing.entry!)).toMatchObject({
    body: "First",
    feedback: null,
    local: true,
  })
})
