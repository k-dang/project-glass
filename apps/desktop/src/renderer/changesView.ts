import type { ChangedFile, DiffSide, LineDiscussion } from "@glass/contracts"
import {
  type CodeViewDiffItem,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  processFile,
} from "@pierre/diffs"
import { type FileTreePreparedInput, prepareFileTreeInput } from "@pierre/trees"
import { Match, Predicate } from "effect"
import type { DraftView } from "./useDrafts"

export type LineNote =
  | { readonly type: "discussion"; readonly discussion: LineDiscussion }
  | { readonly type: "draft"; readonly key: string }
  | { readonly type: "ask"; readonly key: string }

export interface ParsedFile {
  readonly file: ChangedFile
  readonly fileDiff: FileDiffMetadata
  readonly placeholder: string | null
}

/**
 * Diffs reads file names and change type from a git file header, which GitHub's
 * hunks omit.
 */
const toFileDiff = (file: ChangedFile, hunks: string | null): FileDiffMetadata | undefined => {
  const oldPath = file.previousPath ?? file.path
  const header = [`diff --git a/${oldPath} b/${file.path}`]

  if (file.changeType === "added") header.push("new file mode 100644")

  if (file.changeType === "deleted") header.push("deleted file mode 100644")

  // In Git-diff mode, Diffs needs a similarity header to recognize a rename.
  if (file.changeType === "renamed") {
    const similarity = hunks === null ? 100 : 50
    header.push(
      `similarity index ${similarity}%`,
      `rename from ${oldPath}`,
      `rename to ${file.path}`,
    )
  }

  if (hunks !== null) {
    header.push(
      file.changeType === "added" ? "--- /dev/null" : `--- a/${oldPath}`,
      file.changeType === "deleted" ? "+++ /dev/null" : `+++ b/${file.path}`,
      hunks,
    )
  }

  return processFile(`${header.join("\n")}\n`, {
    isGitDiff: true,
    cacheKey: crypto.randomUUID(),
  })
}

const patchContent = Match.type<ChangedFile["patch"]>().pipe(
  Match.tagsExhaustive({
    TextPatch: ({ hunks }) => ({ hunks, placeholder: null }),
    BinaryFile: () => ({ hunks: null, placeholder: "Binary file not shown" }),
    PatchTooLarge: () => ({ hunks: null, placeholder: "Diff too large to show" }),
    EmptyFile: () => ({ hunks: null, placeholder: "Empty file" }),
    NoTextChanges: () => ({ hunks: null, placeholder: "No text changes" }),
  }),
)

const parse = (file: ChangedFile): ParsedFile => {
  const { hunks, placeholder } = patchContent(file.patch)
  const fileDiff = toFileDiff(file, hunks)

  if (fileDiff !== undefined) return { file, fileDiff, placeholder }

  return { file, fileDiff: toFileDiff(file, null)!, placeholder: "Glass couldn't read this diff" }
}

export interface ChangesLayout {
  readonly tree: FileTreePreparedInput
  readonly files: ReadonlyArray<ParsedFile>
}

export const layOut = (files: ReadonlyArray<ChangedFile>): ChangesLayout => {
  const tree = prepareFileTreeInput(files.map((file) => file.path))
  const byPath = new Map(files.map((file) => [file.path, file]))

  return { tree, files: tree.paths.map((path) => parse(byPath.get(path)!)) }
}

export const inHunk = (fileDiff: FileDiffMetadata, side: DiffSide, line: number) =>
  fileDiff.hunks.some((hunk) =>
    side === "new"
      ? line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount
      : line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount,
  )

export interface CollapseChoices {
  readonly opened: ReadonlyMap<string, boolean>
  readonly all: "collapsed" | "expanded"
}

const isCollapsed = (entry: ParsedFile, choices: CollapseChoices) => {
  const { path } = entry.file
  const opened = choices.opened.get(path)

  if (entry.placeholder !== null) return true

  if (opened !== undefined) return !opened

  return choices.all === "collapsed"
}

export const annotationSides: Record<DiffSide, DiffLineAnnotation<LineNote>["side"]> = {
  old: "deletions",
  new: "additions",
}

const groupByPath = <A>(values: ReadonlyArray<A>, pathOf: (value: A) => string) => {
  const byPath = new Map<string, Array<A>>()

  for (const value of values) {
    const path = pathOf(value)
    const group = byPath.get(path)

    if (group === undefined) byPath.set(path, [value])
    else group.push(value)
  }

  return byPath
}

export interface LineNotePlace {
  readonly key: string
  readonly path: string
  readonly side: DiffSide
  readonly line: number
}

export const sameLineNotePlaces = (
  previous: ReadonlyArray<LineNotePlace>,
  next: ReadonlyArray<LineNotePlace>,
) =>
  previous.length === next.length &&
  previous.every((place, index) => {
    const other = next[index]!

    return (
      place.key === other.key &&
      place.path === other.path &&
      place.side === other.side &&
      place.line === other.line
    )
  })

export interface LineNotes {
  readonly discussions: ReadonlyArray<LineDiscussion>
  readonly drafts: ReadonlyArray<LineNotePlace>
  readonly asks: ReadonlyArray<LineNotePlace>
}

const notesOn = (notes: LineNotes) => {
  const discussions = groupByPath(notes.discussions, (discussion) => discussion.path)
  const drafts = groupByPath(notes.drafts, (draft) => draft.path)
  const asks = groupByPath(notes.asks, (ask) => ask.path)

  return (path: string): LineNotes => ({
    discussions: discussions.get(path) ?? [],
    drafts: drafts.get(path) ?? [],
    asks: asks.get(path) ?? [],
  })
}

const annotationsOf = (notes: LineNotes): Array<DiffLineAnnotation<LineNote>> => [
  ...notes.discussions.map((discussion): DiffLineAnnotation<LineNote> => ({
    side: annotationSides[discussion.side],
    lineNumber: discussion.line,
    metadata: { type: "discussion", discussion },
  })),
  ...notes.drafts.map(({ key, side, line }): DiffLineAnnotation<LineNote> => ({
    side: annotationSides[side],
    lineNumber: line,
    metadata: { type: "draft", key },
  })),
  ...notes.asks.map(({ key, side, line }): DiffLineAnnotation<LineNote> => ({
    side: annotationSides[side],
    lineNumber: line,
    metadata: { type: "ask", key },
  })),
]

const drawnKey = (notes: LineNotes, collapsed: boolean, lead: number | undefined) =>
  JSON.stringify([
    collapsed,
    lead,
    notes.discussions.map(({ id, resolved, comments }) => [
      id,
      resolved,
      comments.map((comment) => [comment.id, comment.bodyHtml]),
    ]),
    notes.drafts.map((draft) => draft.key),
    notes.asks.map((ask) => ask.key),
  ])

const hash = (text: string) => {
  let value = 0x811c9dc5

  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193)
  }

  return value >>> 0
}

/**
 * Diffs accepts controlled item-data updates only when the item's version changes. `leads` gives
 * the files that show content above their header, with its estimated height.
 */
export const toItems = (
  files: ReadonlyArray<ParsedFile>,
  notes: LineNotes,
  choices: CollapseChoices,
  leads: ReadonlyMap<string, number> = new Map(),
) => {
  const notesFor = notesOn(notes)

  return files.map((entry): CodeViewDiffItem<LineNote> => {
    const { path } = entry.file
    const fileNotes = notesFor(path)
    const collapsed = isCollapsed(entry, choices)
    const lead = leads.get(path)

    const item: CodeViewDiffItem<LineNote> = {
      type: "diff",
      id: path,
      fileDiff: entry.fileDiff,
      annotations: annotationsOf(fileNotes),
      collapsed,
      version: hash(drawnKey(fileNotes, collapsed, lead)),
    }

    if (lead !== undefined) item.lead = lead

    return item
  })
}

export type ListedNote =
  | { readonly type: "discussion"; readonly discussion: LineDiscussion }
  | { readonly type: "draft"; readonly draft: DraftView }

export interface NoteSection {
  readonly path: string
  readonly notes: ReadonlyArray<ListedNote>
}

export interface ShowNote {
  readonly file: (path: string) => void
  readonly line: (path: string, side: DiffSide, line: number) => void
}

const noteLine = (note: ListedNote) => {
  if (note.type === "discussion") return note.discussion.line

  const { place } = note.draft

  return Predicate.isTagged(place, "LinePlace") ? place.line : Number.MAX_SAFE_INTEGER
}

export const toNoteSections = (
  shown: ReadonlyArray<string>,
  discussions: ReadonlyArray<LineDiscussion>,
  drafts: ReadonlyArray<DraftView>,
): Array<NoteSection> => {
  const byPath = groupByPath<ListedNote>(
    [
      ...discussions.map((discussion): ListedNote => ({ type: "discussion", discussion })),
      ...drafts.map((draft): ListedNote => ({ type: "draft", draft })),
    ],
    (note) => (note.type === "discussion" ? note.discussion.path : note.draft.path),
  )

  const shownSet = new Set(shown)
  const others = [...byPath.keys()].filter((path) => !shownSet.has(path)).toSorted()

  return [...shown, ...others].flatMap((path) => {
    const notes = byPath.get(path)

    return notes === undefined
      ? []
      : [{ path, notes: notes.toSorted((a, b) => noteLine(a) - noteLine(b)) }]
  })
}
