import type { DiffSide, TourCodeTarget } from "@glass/contracts"
import { cn } from "cn"
import { Check, ChevronRight, ChevronUp } from "lucide-react"
import { useAtomValue } from "@effect/atom-react"
import { DateTime } from "effect"
import {
  type Ref,
  type RefObject,
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { ChangedFilesView, type ChangedFilesViewProps, type ViewHandle } from "./ChangedFilesView"
import { annotationSides, type ParsedFile } from "./changesView"
import { LineCounts } from "./LineCounts"
import { plural } from "./plural"
import { allViewed, twoDigits } from "./tourProgress"
import type { TourChapter, TourReading } from "./tourReading"
import { TourText } from "./TourText"
import { TourDiagram } from "./TourDiagram"
import { TourBeforeAfter } from "./TourBeforeAfter"
import { StartReading } from "./TourSidebar"
import { useViewedFiles, type ViewedFilesStore } from "./useViewedFiles"

type ScrollBehavior = "smooth" | "instant"

const tourProse =
  "max-w-[80ch] text-[13px] leading-[1.8] text-muted-foreground wrap-anywhere [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:text-inherit"

const chapterGrid =
  "grid grid-cols-[clamp(300px,30%,400px)_minmax(0,1fr)] overflow-clip rounded-[10px] border bg-[color-mix(in_oklch,var(--muted)_35%,var(--background))] @max-[850px]/tour:grid-cols-[280px_minmax(0,1fr)] @max-[700px]/tour:grid-cols-1"

export interface TourViewHandle {
  showFile: (path: string, behavior?: ScrollBehavior) => void
  returnTo: (path: string) => void
  showLine: (path: string, side: DiffSide, line: number) => void
  showChapter: (index: number, behavior: ScrollBehavior) => void
  showOverview: () => void
  currentChapter: () => number
  viewOf: (path: string) => ViewHandle | null
}

interface TourViewProps extends Omit<
  ChangedFilesViewProps,
  "files" | "summaries" | "searchGroup" | "ref"
> {
  reading: TourReading
  ref: Ref<TourViewHandle>
}

interface ChapterSection {
  element: HTMLElement
  view: RefObject<ViewHandle | null>
}

const useChapterDoneFlags = (
  viewedFiles: TourViewProps["viewedFiles"],
  groups: ReadonlyArray<{ readonly files: ReadonlyArray<ParsedFile> }>,
) =>
  useAtomValue(viewedFiles.stateAtom, ({ viewed }) =>
    groups
      .map(({ files }) =>
        Number(
          allViewed(
            files.map(({ file }) => file.path),
            viewed,
          ),
        ),
      )
      .join(""),
  )

const useReopenedChapters = (done: string) => {
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())

  const collapsed = useCallback(
    (index: number) => done[index] === "1" && !opened.has(index),
    [done, opened],
  )

  const stillDone = [...opened].filter((index) => done[index] === "1")

  if (stillDone.length !== opened.size) setOpened(new Set(stillDone))

  const setChapterOpen = useCallback(
    (index: number, open: boolean) =>
      setOpened((before) => {
        const after = new Set(before)

        if (open) after.add(index)
        else after.delete(index)

        return after
      }),
    [],
  )

  return { opened, collapsed, setChapterOpen }
}

export function TourView(props: TourViewProps) {
  const { reading, ref, onCurrentPathChange, onOpenChange } = props
  const container = useRef<HTMLDivElement>(null)
  const sections = useRef(new Map<number, ChapterSection>())

  const [initial] = useState(() => {
    const entry = reading.files.find(({ file }) => file.path === props.initialPath)

    return entry === undefined
      ? null
      : {
          path: entry.file.path,
          chapter: reading.chapterOf.get(entry.file.path) ?? reading.chapters.length,
        }
  })

  const ready = useRef(initial === null)

  const [selected, setSelected] = useState<ReadonlyMap<number, string>>(
    () => new Map(initial === null ? [] : [[initial.chapter, initial.path]]),
  )

  const groups = useMemo(() => {
    const byPath = new Map(reading.files.map((entry) => [entry.file.path, entry]))

    const chapters = reading.chapters.map((chapter) => ({
      chapter,
      files: chapter.paths.map((path) => byPath.get(path)!),
    }))

    const rest = reading.files.filter(({ file }) => !reading.chapterOf.has(file.path))

    return rest.length === 0 ? chapters : [...chapters, { chapter: null, files: rest }]
  }, [reading])

  const done = useChapterDoneFlags(props.viewedFiles, groups)
  const { opened, collapsed, setChapterOpen } = useReopenedChapters(done)

  const open = useCallback(
    (index: number) => {
      if (collapsed(index)) flushSync(() => setChapterOpen(index, true))
    },
    [collapsed, setChapterOpen],
  )

  const chapterOf = useCallback(
    (path: string) => reading.chapterOf.get(path) ?? reading.chapters.length,
    [reading],
  )

  const currentChapter = useCallback(() => {
    const root = container.current

    if (root === null) return -1

    const top = root.getBoundingClientRect().top
    const atEnd = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 1
    let index = -1

    for (const [candidate, { element }] of sections.current) {
      if (atEnd || element.getBoundingClientRect().top <= top + 24)
        index = Math.max(index, candidate)
    }

    return index
  }, [])

  const revealChapter = useCallback((index: number, behavior: ScrollBehavior) => {
    const root = container.current
    const section = sections.current.get(index)

    if (root === null || section === undefined) return undefined

    return requestAnimationFrame(() => {
      if (!root.isConnected || !section.element.isConnected) return

      const top =
        section.element.getBoundingClientRect().top -
        root.getBoundingClientRect().top +
        root.scrollTop -
        20

      root.scrollTo({
        top: Math.max(0, top),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : behavior,
      })
      ready.current = true
    })
  }, [])

  const inView = useRef(initial?.chapter ?? 0)
  const wasDone = useRef(done)

  useLayoutEffect(() => {
    const before = wasDone.current
    wasDone.current = done
    const finishedChapter = inView.current

    if (done[finishedChapter] !== "1" || before[finishedChapter] !== "0") return

    const root = container.current
    const nextUnfinished = sections.current.get(done.indexOf("0", finishedChapter + 1))

    if (root === null || nextUnfinished === undefined) return

    root.scrollTop +=
      nextUnfinished.element.getBoundingClientRect().top - root.getBoundingClientRect().top - 20
  }, [done])

  useLayoutEffect(() => {
    if (initial === null) return undefined

    const frame = revealChapter(initial.chapter, "instant")

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [initial, revealChapter])

  const selectFile = useCallback(
    (index: number, path: string) => {
      setSelected((before) =>
        before.get(index) === path ? before : new Map(before).set(index, path),
      )
      onCurrentPathChange(path)
    },
    [onCurrentPathChange],
  )

  const searchGroup = useMemo<NonNullable<ChangedFilesViewProps["searchGroup"]>>(
    () => ({
      getContainerElement: () => container.current,
      getViews: () =>
        [...sections.current]
          .toSorted(([left], [right]) => left - right)
          .flatMap(([, { view }]) => {
            const instance = view.current?.getInstance()

            return instance === undefined ? [] : [instance]
          }),
      onReveal: (viewer, item) => {
        for (const [index, { view }] of sections.current) {
          if (view.current?.getInstance() !== viewer) continue

          selectFile(index, item.id)
          revealChapter(index, "instant")
          break
        }
      },
    }),
    [revealChapter, selectFile],
  )

  const scrollToFile = useCallback(
    (index: number, path: string, behavior: ScrollBehavior) => {
      revealChapter(index, behavior)
      selectFile(index, path)
      sections.current
        .get(index)
        ?.view.current?.scrollTo({ type: "item", id: path, align: "start", behavior })
    },
    [revealChapter, selectFile],
  )

  const showTarget = useCallback(
    (target: TourCodeTarget) => {
      const { path, side, startLine, endLine } = target
      const index = chapterOf(path)
      selectFile(index, path)
      onOpenChange(path, true)
      const view = sections.current.get(index)?.view.current
      view?.setSelectedLines({
        id: path,
        range: { start: startLine, end: endLine, side: annotationSides[side] },
      })
      view?.scrollTo({
        type: "line",
        id: path,
        side: annotationSides[side],
        lineNumber: startLine,
        align: "center",
        behavior: "instant",
      })
    },
    [chapterOf, selectFile, onOpenChange],
  )

  const showChapter = useCallback(
    (index: number, behavior: ScrollBehavior) => {
      revealChapter(index, behavior)
      const path = groups[index]?.files[0]?.file.path

      if (path !== undefined) selectFile(index, path)
    },
    [groups, revealChapter, selectFile],
  )

  const showTargetInChapter = useCallback(
    (target: TourCodeTarget) => {
      const index = chapterOf(target.path)
      open(index)
      revealChapter(index, "instant")
      showTarget(target)
    },
    [chapterOf, open, revealChapter, showTarget],
  )

  useImperativeHandle(
    ref,
    () => ({
      currentChapter,
      viewOf: (path) => sections.current.get(chapterOf(path))?.view.current ?? null,
      showChapter,
      showOverview: () => {
        requestAnimationFrame(() => container.current?.scrollTo({ top: 0, behavior: "instant" }))
      },
      showFile: (path, behavior = "instant") => {
        const index = chapterOf(path)
        open(index)
        scrollToFile(index, path, behavior)
      },
      returnTo: (path) => {
        const index = chapterOf(path)

        if (collapsed(index)) revealChapter(index, "instant")
        else scrollToFile(index, path, "instant")
      },
      showLine: (path, side, line) =>
        showTargetInChapter({ path, side, startLine: line, endLine: line }),
    }),
    [
      currentChapter,
      showChapter,
      showTargetInChapter,
      revealChapter,
      open,
      collapsed,
      scrollToFile,
      chapterOf,
    ],
  )

  return (
    <div
      className="@container-size/tour relative min-h-0 flex-1 overflow-auto border-t px-6 py-5 [--tour-card-height:clamp(420px,100cqh,720px)] [scrollbar-gutter:stable]"
      ref={container}
      aria-label="Tour Chapters"
      onScroll={() => {
        const index = Math.max(currentChapter(), 0)
        inView.current = index

        if (!ready.current) return

        const path = selected.get(index) ?? groups[index]?.files[0]?.file.path

        if (path !== undefined) onCurrentPathChange(path)
      }}
    >
      {reading.beforeAfter !== null && (
        <TourOverview
          intent={reading.intent}
          beforeAfter={reading.beforeAfter}
          chapterCount={reading.chapters.length}
          fileCount={reading.files.length}
          onStart={() => showChapter(0, "smooth")}
          onShowTarget={showTargetInChapter}
        />
      )}
      {groups.map(({ chapter, files }, index) => (
        <ChapterCard
          key={`${DateTime.formatIso(reading.writtenAt)}:${index}`}
          diff={props}
          searchGroup={searchGroup}
          chapter={chapter}
          chapterCount={reading.chapters.length}
          files={files}
          collapsed={collapsed(index)}
          onOpen={() => setChapterOpen(index, true)}
          onCollapse={opened.has(index) ? () => setChapterOpen(index, false) : undefined}
          initialPath={initial?.chapter === index ? initial.path : null}
          path={selected.get(index) ?? files[0]?.file.path}
          register={(element, view) => {
            if (element === null) sections.current.delete(index)
            else sections.current.set(index, { element, view })
          }}
          onSelect={(path) => selectFile(index, path)}
          onShowTarget={showTarget}
          onCurrentPath={(path) => {
            if (ready.current && currentChapter() === index) selectFile(index, path)
          }}
        />
      ))}
    </div>
  )
}

function TourOverview(props: {
  intent: string
  beforeAfter: NonNullable<TourReading["beforeAfter"]>
  chapterCount: number
  fileCount: number
  onStart: () => void
  onShowTarget: (target: TourCodeTarget) => void
}) {
  const heading = useId()

  return (
    <section className={cn(chapterGrid, "[&+section]:mt-5")} aria-labelledby={heading}>
      <div className="min-w-0 px-5 py-5.5 @max-[850px]/tour:p-4">
        <h2 id={heading} className="text-base leading-6 font-semibold">
          Tour overview
        </h2>
        <p className="mt-2.5 mb-5 font-mono text-[11px] text-muted-foreground uppercase">
          {plural(props.chapterCount, "Chapter")} · {plural(props.fileCount, "file")}
        </p>
        <p className={tourProse}>
          <TourText text={props.intent} />
        </p>
        <div className="mt-4">
          <StartReading onStart={props.onStart} />
        </div>
      </div>
      <div className="min-w-0 border-l p-4.5 @max-[850px]/tour:p-3.5 @max-[700px]/tour:border-t @max-[700px]/tour:border-l-0">
        <TourBeforeAfter beforeAfter={props.beforeAfter} onSelect={props.onShowTarget} />
      </div>
    </section>
  )
}

function ChapterCard(props: {
  diff: TourViewProps
  searchGroup: NonNullable<ChangedFilesViewProps["searchGroup"]>
  chapter: TourChapter | null
  chapterCount: number
  files: ReadonlyArray<ParsedFile>
  collapsed: boolean
  onOpen: () => void
  onCollapse: (() => void) | undefined
  path: string | undefined
  initialPath: string | null
  register: (element: HTMLElement | null, view: RefObject<ViewHandle | null>) => void
  onSelect: (path: string) => void
  onShowTarget: (target: TourCodeTarget) => void
  onCurrentPath: (path: string) => void
}) {
  const view = useRef<ViewHandle>(null)
  const heading = useId()
  const { chapter, files } = props
  const paths = useMemo(() => files.map(({ file }) => file.path), [files])
  const title = chapter?.title ?? "Everything else"

  const paragraphs = (chapter?.explanation ?? "Files the Tour didn't place in a Chapter.").split(
    "\n\n",
  )

  const toggle = useRef<HTMLButtonElement>(null)
  const wasCollapsed = useRef(props.collapsed)

  useLayoutEffect(() => {
    if (wasCollapsed.current === props.collapsed) return

    wasCollapsed.current = props.collapsed

    if (document.activeElement === null || document.activeElement === document.body)
      toggle.current?.focus({ focusVisible: false })
  }, [props.collapsed])

  return (
    <section
      className={cn(!props.collapsed && chapterGrid, "[&+section]:mt-5")}
      aria-labelledby={heading}
      ref={(element) => props.register(element, view)}
    >
      {props.collapsed ? (
        <button
          type="button"
          ref={toggle}
          aria-expanded={false}
          onClick={props.onOpen}
          className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[10px] border bg-[color-mix(in_oklch,var(--muted)_35%,var(--background))] px-4 py-2.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            aria-hidden
            className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-(--viewed) text-background"
          >
            <Check className="size-3" strokeWidth={3} />
          </span>
          {chapter !== null && (
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {twoDigits(chapter.index + 1)}
            </span>
          )}
          <span
            id={heading}
            className="max-w-[40%] shrink-0 truncate font-semibold @max-[700px]/tour:max-w-none @max-[700px]/tour:flex-1"
          >
            {title}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground @max-[700px]/tour:hidden [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:text-inherit">
            <TourText text={paragraphs[0]!} />
          </span>
          <span className="flex shrink-0 gap-2.5 font-mono text-[11px] text-muted-foreground">
            {plural(files.length, "file")}
            <LineCounts
              additions={files.reduce((sum, { file }) => sum + file.additions, 0)}
              deletions={files.reduce((sum, { file }) => sum + file.deletions, 0)}
            />
          </span>
        </button>
      ) : (
        <>
          <aside
            className={cn(
              "max-h-(--tour-card-height) min-w-0 overflow-y-auto px-5 py-5.5 [scrollbar-width:thin] @max-[850px]/tour:p-4",
              chapter?.beforeAfter == null
                ? "@max-[700px]/tour:max-h-75"
                : "@max-[700px]/tour:max-h-none",
            )}
            aria-label={`Chapter explanation: ${title}`}
          >
            <div className="flex items-start gap-2">
              <h2 id={heading} className="min-w-0 flex-1 text-base leading-6 font-semibold">
                {title}
              </h2>
              {props.onCollapse !== undefined && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  ref={toggle}
                  aria-expanded
                  aria-label={`Collapse Chapter: ${title}`}
                  title="Collapse"
                  onClick={props.onCollapse}
                  className="-mr-1.5 text-muted-foreground"
                >
                  <ChevronUp aria-hidden />
                </Button>
              )}
            </div>
            <ChapterProgress
              title={title}
              chapter={chapter}
              count={props.chapterCount}
              paths={paths}
              store={props.diff.viewedFiles}
              onChange={props.diff.onViewedChange}
            />
            <div className={cn(tourProse, "[&_p+p]:mt-3")}>
              {paragraphs.map((paragraph, index) => (
                <p key={index}>
                  <TourText text={paragraph} />
                </p>
              ))}
            </div>
            {chapter !== null && chapter.callouts.length > 0 && (
              <ChapterCallouts
                callouts={chapter.callouts}
                title={title}
                onShowTarget={props.onShowTarget}
              />
            )}
            {chapter?.beforeAfter != null && (
              <div className="my-5">
                <TourBeforeAfter beforeAfter={chapter.beforeAfter} onSelect={props.onShowTarget} />
              </div>
            )}
          </aside>
          <div
            className={cn(
              "flex h-(--tour-card-height) min-h-0 min-w-0 flex-col border-l px-4.5 pt-4 pb-4.5 @max-[850px]/tour:p-3.5 @max-[700px]/tour:h-115 @max-[700px]/tour:border-t @max-[700px]/tour:border-l-0",
            )}
          >
            {files.length > 0 && (
              <ChapterFiles
                files={files}
                path={props.path}
                store={props.diff.viewedFiles}
                onSelect={(path) => {
                  props.onSelect(path)
                  props.diff.onOpenChange(path, true)
                  view.current?.scrollTo({ type: "item", id: path, align: "start" })
                }}
                title={title}
              />
            )}
            {chapter?.diagram != null && (
              <TourDiagram
                diagram={chapter.diagram}
                chapterTitle={title}
                path={props.path}
                onSelect={(node) => props.onShowTarget(node.target)}
              />
            )}
            {files.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No files remain in this Chapter.</p>
            ) : (
              <ChangedFilesView
                {...props.diff}
                initialPath={props.initialPath}
                files={files}
                summaries={props.diff.reading.summaries}
                searchGroup={props.searchGroup}
                ref={view}
                onCurrentPathChange={props.onCurrentPath}
              />
            )}
          </div>
        </>
      )}
    </section>
  )
}

function ChapterProgress(props: {
  title: string
  chapter: TourChapter | null
  count: number
  paths: ReadonlyArray<string>
  store: ViewedFilesStore
  onChange: (paths: ReadonlyArray<string>, viewed: boolean) => void
}) {
  const viewed = useViewedFiles(props.store)
  const count = props.paths.filter((path) => viewed.viewed.has(path)).length
  const done = count === props.paths.length && count > 0
  const id = useId()

  return (
    <div className="mt-2.5 mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
      {props.chapter !== null && (
        <span className="font-mono text-[11px] text-muted-foreground">
          CHAPTER {twoDigits(props.chapter.index + 1)} / {twoDigits(props.count)}
        </span>
      )}
      {props.paths.length > 0 && (
        <>
          <Label
            htmlFor={id}
            className="cursor-pointer gap-1.5 text-xs font-normal text-muted-foreground has-disabled:cursor-default"
          >
            <Checkbox
              id={id}
              checked={done}
              indeterminate={count > 0 && !done}
              disabled={viewed.locked}
              aria-busy={props.paths.some((path) => viewed.saving.has(path))}
              aria-label={`Chapter viewed: ${props.title}`}
              onCheckedChange={(checked) => props.onChange(props.paths, checked)}
              className="data-checked:border-(--viewed) data-checked:bg-(--viewed) data-checked:text-background"
            />
            {done ? "Viewed" : "Mark viewed"}
          </Label>
          <span className="font-mono text-[10px] text-muted-foreground" aria-live="polite">
            {count}/{props.paths.length} viewed
          </span>
        </>
      )}
    </div>
  )
}

function ChapterFiles(props: {
  files: ReadonlyArray<ParsedFile>
  path: string | undefined
  store: ViewedFilesStore
  onSelect: (path: string) => void
  title: string
}) {
  const viewed = useViewedFiles(props.store)
  const strip = useRef<HTMLElement>(null)
  const names = useMemo(() => fileLabels(props.files), [props.files])

  useLayoutEffect(() => {
    const nav = strip.current

    const tab =
      props.path === undefined
        ? null
        : nav?.querySelector<HTMLElement>(`[data-path="${CSS.escape(props.path)}"]`)

    if (!nav || !tab) return

    if (tab.offsetLeft < nav.scrollLeft) nav.scrollLeft = tab.offsetLeft
    else if (tab.offsetLeft + tab.offsetWidth > nav.scrollLeft + nav.clientWidth)
      nav.scrollLeft = tab.offsetLeft + tab.offsetWidth - nav.clientWidth
  }, [props.path])

  return (
    <nav
      ref={strip}
      className="relative mb-3 flex shrink-0 gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]"
      aria-label={`Files in ${props.title}`}
    >
      {props.files.map(({ file }) => (
        <button
          type="button"
          key={file.path}
          className="flex shrink-0 cursor-pointer items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 transition-transform duration-150 ease-out hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:scale-[0.98] aria-[current=location]:border-(--viewed) aria-[current=location]:bg-[color-mix(in_oklch,var(--viewed)_10%,var(--background))]"
          aria-current={props.path === file.path ? "location" : undefined}
          onClick={() => props.onSelect(file.path)}
          title={file.path}
          data-path={file.path}
        >
          {viewed.viewed.has(file.path) && (
            <Check aria-label="Viewed" className="size-3 shrink-0 text-(--viewed)" />
          )}
          <span className="font-mono text-[11px] font-medium whitespace-nowrap">
            {names.get(file.path)}
          </span>
          <LineCounts additions={file.additions} deletions={file.deletions} />
        </button>
      ))}
    </nav>
  )
}

const fileLabels = (files: ReadonlyArray<ParsedFile>) => {
  const segments = files.map(({ file }) => file.path.split("/"))
  const labels = new Map<string, string>()

  for (const parts of segments) {
    let depth = 1
    const label = () => parts.slice(-depth).join("/")

    while (
      depth < parts.length &&
      segments.some((other) => other !== parts && other.slice(-depth).join("/") === label())
    )
      depth++

    labels.set(parts.join("/"), label())
  }

  return labels
}

function ChapterCallouts(props: {
  callouts: TourChapter["callouts"]
  title: string
  onShowTarget: (target: TourCodeTarget) => void
}) {
  return (
    <nav className="mt-5 max-w-[80ch]" aria-label={`Code callouts for ${props.title}`}>
      <h3 className="mb-2 font-mono text-[10px] font-normal tracking-wider text-muted-foreground uppercase">
        Callouts
      </h3>
      <ol className="divide-y border-y">
        {props.callouts.map((callout, index) => (
          <li key={index}>
            <button
              type="button"
              className="group flex w-full cursor-pointer items-start gap-2.5 px-1 py-2 text-left text-[12.5px] leading-5 wrap-anywhere text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              onClick={() => props.onShowTarget(callout.target)}
            >
              <span
                aria-hidden
                className="mt-px w-4 shrink-0 font-mono text-[11px] text-(--viewed) tabular-nums"
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 [&_code]:text-[11.5px]">
                <TourText text={callout.label} />
              </span>
              <span
                aria-hidden
                className="mt-px shrink-0 text-muted-foreground/60 transition-transform duration-150 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
              >
                ↗
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
