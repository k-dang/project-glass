import {
  BinaryFile,
  FlaggedPlace,
  LineDiscussion,
  LinePlace,
  PublishedComment,
  TextPatch,
} from "@glass/contracts"
import { DateTime } from "effect"
import { describe, expect, it } from "vite-plus/test"
import {
  type CollapseChoices,
  inHunk,
  layOut,
  type LineNotePlace,
  type LineNotes,
  toItems,
  toNoteSections,
} from "./changesView"
import type { DraftView } from "./useDrafts"
import { changedFile, hunks } from "../../test/workspace"

const comment = (id: string) =>
  new PublishedComment({
    id,
    author: "hubot",
    avatarUrl: null,
    bodyHtml: "<p>Why?</p>",
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  })

const discussion = (path: string, line: number, resolved = false, replies = 0) =>
  new LineDiscussion({
    id: `T-${path}-${line}`,
    path,
    side: "new",
    line,
    resolved,
    comments: [
      comment(`C-${path}-${line}`),
      ...Array.from({ length: replies }, (_, index) => comment(`R-${path}-${line}-${index}`)),
    ],
  })

const draft = (key: string, path: string): LineNotePlace => ({ key, path, side: "new", line: 2 })

const none = new Map<string, boolean>()

const lineNotes = (some: Partial<LineNotes> = {}): LineNotes => ({
  discussions: [],
  drafts: [],
  asks: [],
  ...some,
})

const choose = (
  opened: ReadonlyMap<string, boolean> = none,
  all: CollapseChoices["all"] = "expanded",
): CollapseChoices => ({ opened, all })

const redrawn = (before: ReturnType<typeof toItems>, after: ReturnType<typeof toItems>) =>
  after.filter((item, index) => item.version !== before[index]!.version).map((item) => item.id)

describe("layOut", () => {
  it("retains highlight keys through redraws and isolates files and newly loaded content", () => {
    const { files } = layOut([changedFile("a.ts"), changedFile("b.ts")])
    const keys = files.map(({ fileDiff }) => fileDiff.cacheKey)

    expect(keys).toEqual([expect.stringMatching(/\S/), expect.stringMatching(/\S/)])
    expect(new Set(keys).size).toBe(2)
    expect(toItems(files, lineNotes(), choose())[0]!.fileDiff.cacheKey).toBe(keys[0])

    const reloaded = layOut([
      changedFile("a.ts", TextPatch.make({ hunks: hunks.replace("+B", "+C") })),
    ])

    expect(reloaded.files[0]!.fileDiff.cacheKey).not.toBe(keys[0])
  })

  it("orders the diffs as the tree lists them, folders first", () => {
    const { tree, files } = layOut(
      ["README.md", "src/b.ts", "src.ts", "src/lib/a.ts", "docs/guide.md"].map((path) =>
        changedFile(path),
      ),
    )

    const order = ["docs/guide.md", "src/lib/a.ts", "src/b.ts", "README.md", "src.ts"]

    expect(tree.paths).toEqual(order)
    expect(files.map((entry) => entry.file.path)).toEqual(order)
  })
})

describe("toItems", () => {
  const { files } = layOut([changedFile("a.ts"), changedFile("b.ts"), changedFile("c.ts")])
  const plain = toItems(files, lineNotes(), choose())

  it("redraws only the file whose Drafts changed", () => {
    const started = toItems(files, lineNotes({ drafts: [draft("1", "b.ts")] }), choose())

    expect(redrawn(plain, started)).toEqual(["b.ts"])
    expect(redrawn(started, plain)).toEqual(["b.ts"])
  })

  it("redraws only the file whose Discussions changed", () => {
    const one = toItems(files, lineNotes({ discussions: [discussion("a.ts", 2)] }), choose())

    const two = toItems(
      files,
      lineNotes({ discussions: [discussion("a.ts", 2), discussion("c.ts", 1)] }),
      choose(),
    )

    expect(redrawn(one, two)).toEqual(["c.ts"])
  })

  it("redraws a Discussion's file when it gains a Reply or is resolved", () => {
    const before = toItems(
      files,
      lineNotes({ discussions: [discussion("a.ts", 2), discussion("c.ts", 1)] }),
      choose(),
    )

    const replied = toItems(
      files,
      lineNotes({ discussions: [discussion("a.ts", 2, false, 1), discussion("c.ts", 1)] }),
      choose(),
    )

    const resolved = toItems(
      files,
      lineNotes({ discussions: [discussion("a.ts", 2, true), discussion("c.ts", 1)] }),
      choose(),
    )

    expect(redrawn(before, replied)).toEqual(["a.ts"])
    expect(redrawn(before, resolved)).toEqual(["a.ts"])
  })

  it("redraws only the file that collapsed", () => {
    const closed = toItems(files, lineNotes(), choose(new Map([["a.ts", false]])))

    expect(redrawn(plain, closed)).toEqual(["a.ts"])
    expect(closed.map((item) => item.collapsed)).toEqual([true, false, false])
  })

  it("places Discussions and Drafts under their lines", () => {
    const [a, b] = toItems(
      files,
      lineNotes({ discussions: [discussion("a.ts", 3)], drafts: [draft("1", "a.ts")] }),
      choose(),
    )

    expect(a!.annotations).toEqual([
      {
        side: "additions",
        lineNumber: 3,
        metadata: expect.objectContaining({ type: "discussion" }),
      },
      { side: "additions", lineNumber: 2, metadata: { type: "draft", key: "1" } },
    ])
    expect(b!.annotations).toEqual([])
  })
})

describe("collapsed", () => {
  const { files } = layOut([changedFile("a.ts"), changedFile("b.png", BinaryFile.make({}))])

  const collapsed = (opened: ReadonlyMap<string, boolean>, all?: CollapseChoices["all"]) =>
    toItems(files, lineNotes(), choose(opened, all)).map((item) => item.collapsed)

  it("applies global and per-file collapse choices while keeping placeholders collapsed", () => {
    expect(collapsed(none, "collapsed")).toEqual([true, true])
    expect(collapsed(none, "expanded")).toEqual([false, true])
    expect(collapsed(new Map([["a.ts", true]]), "collapsed")).toEqual([false, true])
    expect(collapsed(new Map([["b.png", true]]))).toEqual([false, true])
  })
})

describe("inHunk", () => {
  const { fileDiff } = layOut([changedFile("a.ts")]).files[0]!

  it("takes lines inside the diff's hunks only", () => {
    expect(inHunk(fileDiff, "new", 2)).toBe(true)
    expect(inHunk(fileDiff, "old", 3)).toBe(true)
    expect(inHunk(fileDiff, "new", 4)).toBe(false)
  })
})

const view = (key: string, path: string, place: DraftView["place"]): DraftView => ({
  key,
  path,
  place,
  body: "Hm",
  feedback: { type: "draft" },
  local: false,
  deleting: false,
  published: false,
})

const summary = (sections: ReturnType<typeof toNoteSections>) =>
  sections.map(({ path, notes }) => [
    path,
    notes.map((note) =>
      note.type === "discussion" ? `T${note.discussion.line}` : `D:${note.draft.key}`,
    ),
  ])

describe("toNoteSections", () => {
  const shown = ["src/lib/c.ts", "src/b.ts", "a.ts"]

  it("groups notes by file in the diffs' order, each file's notes by line", () => {
    const sections = toNoteSections(
      shown,
      [discussion("a.ts", 9), discussion("src/b.ts", 4), discussion("a.ts", 2)],
      [view("1", "a.ts", LinePlace.make({ side: "new", line: 5 }))],
    )

    expect(summary(sections)).toEqual([
      ["src/b.ts", ["T4"]],
      ["a.ts", ["T2", "D:1", "T9"]],
    ])
  })

  it("lists Flagged drafts after their file's lines, and files the diffs don't show last", () => {
    const flagged = FlaggedPlace.make({ originalLine: 3, diffHunk: "" })

    const sections = toNoteSections(
      shown,
      [discussion("a.ts", 7)],
      [view("1", "gone.ts", flagged), view("2", "a.ts", flagged)],
    )

    expect(summary(sections)).toEqual([
      ["a.ts", ["T7", "D:2"]],
      ["gone.ts", ["D:1"]],
    ])
  })
})
