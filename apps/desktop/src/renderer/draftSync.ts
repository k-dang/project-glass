import type { DiffSide, DraftPlace } from "@glass/contracts"
import { Match, Predicate } from "effect"
import type { Problem } from "./problems"

type DraftAction = "save" | "delete"

export type Feedback =
  | { readonly type: "draft" }
  | { readonly type: "unsaved" }
  | { readonly type: "sending"; readonly action: DraftAction }
  | { readonly type: "failed"; readonly action: DraftAction; readonly problem: Problem }
  | null

export interface DraftView {
  readonly key: string
  readonly path: string
  readonly place: DraftPlace
  readonly body: string
  readonly feedback: Feedback
  readonly deleting: boolean
  readonly local: boolean
}

export interface SavedDraft {
  readonly id: string
  readonly body: string
}

export type DraftWrite =
  | {
      readonly type: "create"
      readonly path: string
      readonly side: DiffSide
      readonly line: number
      readonly body: string
    }
  | { readonly type: "update"; readonly id: string; readonly body: string }
  | { readonly type: "delete"; readonly id: string }

type Sync =
  | { readonly type: "idle" }
  | { readonly type: "writing"; readonly action: DraftAction }
  | { readonly type: "failed"; readonly action: DraftAction; readonly problem: Problem }

export interface DraftEntry {
  readonly key: string
  readonly path: string
  readonly place: DraftPlace
  readonly body: string
  readonly saved: SavedDraft | null
  readonly intent: "edit" | "save" | "remove"
  readonly sync: Sync
}

export type DraftEvent =
  | { readonly type: "edit"; readonly body: string }
  | { readonly type: "save" | "remove" | "discard" | "missing" }
  | { readonly type: "saved"; readonly saved: SavedDraft | null }
  | { readonly type: "failed"; readonly problem: Problem }

interface Step {
  readonly entry: DraftEntry | null
  readonly write: DraftWrite | null
}

export const pendingDraftWrite = (entry: DraftEntry): DraftWrite | null => {
  const { saved, body, place, path } = entry

  if (entry.intent === "remove" || body.trim() === "")
    return saved === null ? null : { type: "delete", id: saved.id }

  if (saved !== null) return body === saved.body ? null : { type: "update", id: saved.id, body }

  return Predicate.isTagged(place, "LinePlace")
    ? { type: "create", path, side: place.side, line: place.line, body }
    : null
}

const needsDraftWrite = (entry: DraftEntry) =>
  entry.sync.type === "writing" || pendingDraftWrite(entry) !== null

export const isLocalDraft = (entry: DraftEntry) =>
  entry.saved === null && entry.sync.type !== "writing"

const actionOf = (write: DraftWrite): DraftAction => (write.type === "delete" ? "delete" : "save")

const feedbackOf = (entry: DraftEntry): Feedback => {
  if (entry.sync.type === "failed") return entry.sync

  if (entry.sync.type === "writing") return { type: "sending", action: entry.sync.action }

  if (pendingDraftWrite(entry) !== null) return { type: "unsaved" }

  return entry.saved === null ? null : { type: "draft" }
}

export const draftView = (entry: DraftEntry): DraftView => ({
  key: entry.key,
  path: entry.path,
  place: entry.place,
  body: entry.body,
  feedback: feedbackOf(entry),
  deleting: entry.intent === "remove",
  local: isLocalDraft(entry),
})

const reconcile = (entry: DraftEntry): Step => {
  if (entry.sync.type === "writing") return { entry, write: null }

  if (entry.intent === "remove" && entry.saved === null) return { entry: null, write: null }

  const ready: DraftEntry = {
    ...entry,
    intent: entry.intent === "remove" ? "remove" : "edit",
  }

  const write = pendingDraftWrite(ready)

  return {
    entry:
      write === null ? ready : { ...ready, sync: { type: "writing", action: actionOf(write) } },
    write,
  }
}

export const stepDraft = (entry: DraftEntry, event: DraftEvent): Step =>
  Match.value(event).pipe(
    Match.withReturnType<Step>(),
    Match.discriminatorsExhaustive("type")({
      edit: ({ body }) => ({
        entry:
          entry.intent === "remove"
            ? entry
            : {
                ...entry,
                body,
                sync: entry.sync.type === "failed" ? { type: "idle" } : entry.sync,
              },
        write: null,
      }),
      save: () =>
        needsDraftWrite(entry)
          ? reconcile({ ...entry, intent: entry.intent === "remove" ? "remove" : "save" })
          : { entry, write: null },
      remove: () => reconcile({ ...entry, intent: "remove" }),
      discard: () => ({
        entry:
          entry.saved === null
            ? null
            : {
                ...entry,
                body: entry.saved.body,
                intent: entry.intent === "save" ? "save" : "edit",
                sync: entry.sync.type === "failed" ? { type: "idle" } : entry.sync,
              },
        write: null,
      }),
      saved: ({ saved }) => {
        if (entry.sync.type !== "writing") return { entry, write: null }

        const settled: DraftEntry = { ...entry, saved, sync: { type: "idle" } }

        return settled.intent === "edit" ? { entry: settled, write: null } : reconcile(settled)
      },
      missing: () =>
        entry.sync.type === "writing"
          ? reconcile({
              ...entry,
              saved: null,
              intent: entry.intent === "remove" ? "remove" : "save",
              sync: { type: "idle" },
            })
          : { entry, write: null },
      failed: ({ problem }) => {
        if (entry.sync.type !== "writing") return { entry, write: null }

        if (entry.intent === "remove" && entry.sync.action === "save")
          return reconcile({ ...entry, sync: { type: "idle" } })

        return {
          entry: {
            ...entry,
            sync: { type: "failed", action: entry.sync.action, problem },
          },
          write: null,
        }
      },
    }),
  )
