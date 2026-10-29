import type { DiffSide } from "@glass/contracts"
import { Check, ChevronRight, ChevronUp } from "lucide-react"
import { useAtomValue } from "@effect/atom-react"
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
import { plural } from "./plural"
import { allViewed, twoDigits } from "./tourProgress"
import type { TourChapter, TourReading } from "./tourReading"
import { TourText } from "./TourText"
import { useViewedFiles, type ViewedFilesStore } from "./useViewedFiles"

type ScrollBehavior = "smooth" | "instant"

export interface TourViewHandle {
  showFile: (path: string, behavior?: ScrollBehavior) => void
  /** Scrolls back to the current file, leaving a collapsed Chapter collapsed. */
  returnTo: (path: string) => void
  showLine: (path: string, side: DiffSide, line: number) => void
  showChapter: (index: number, behavior: ScrollBehavior) => void
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

export function TourView(props: TourViewProps) {
  const { reading, ref, onCurrentPathChange } = props
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

  // Viewed Chapters collapse to a row unless the user reopened them.
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())

  const groups = useMemo(() => {
    const byPath = new Map(reading.files.map((entry) => [entry.file.path, entry]))

    const chapters = reading.chapters.map((chapter) => ({
      chapter,
      files: chapter.paths.map((path) => byPath.get(path)!),
    }))

    const rest = reading.files.filter(({ file }) => !reading.chapterOf.has(file.path))

    return rest.length === 0 ? chapters : [...chapters, { chapter: null, files: rest }]
  }, [reading])

  // A string, so the Tour re-renders only when a Chapter becomes viewed or unviewed.
  const done = useAtomValue(props.viewedFiles.stateAtom, ({ viewed }) =>
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

  const collapsed = useCallback(
    (index: number) => done[index] === "1" && !opened.has(index),
    [done, opened],
  )

  // Unviewing a reopened Chapter forgets it, so viewing it again collapses it again.
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

    if (root === null) return 0

    const top = root.getBoundingClientRect().top
    const atEnd = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 1
    let index = 0

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

    // Container queries settle after a newly mounted Tour's first layout.
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

  useImperativeHandle(
    ref,
    () => ({
      currentChapter,
      viewOf: (path) => sections.current.get(chapterOf(path))?.view.current ?? null,
      showChapter: (index, behavior) => {
        revealChapter(index, behavior)
        const path = groups[index]?.files[0]?.file.path

        if (path !== undefined) selectFile(index, path)
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
      showLine: (path, side, line) => {
        const index = chapterOf(path)
        open(index)
        revealChapter(index, "instant")
        selectFile(index, path)
        const view = sections.current.get(index)?.view.current
        view?.setSelectedLines({
          id: path,
          range: { start: line, end: line, side: annotationSides[side] },
        })
        view?.scrollTo({
          type: "line",
          id: path,
          side: annotationSides[side],
          lineNumber: line,
          align: "center",
          behavior: "smooth-auto",
        })
      },
    }),
    [groups, currentChapter, revealChapter, selectFile, open, collapsed, scrollToFile, chapterOf],
  )

  return (
    <div
      className="@container/tour relative min-h-0 flex-1 overflow-auto border-t px-6 py-5 [--tour-card-height:clamp(420px,calc(100dvh_-_235px),720px)] [scrollbar-gutter:stable]"
      ref={container}
      aria-label="Tour Chapters"
      onScroll={() => {
        if (!ready.current) return

        const index = currentChapter()
        const path = selected.get(index) ?? groups[index]?.files[0]?.file.path

        if (path !== undefined) onCurrentPathChange(path)
      }}
    >
      {groups.map(({ chapter, files }, index) => (
        <ChapterCard
          key={index}
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
          onCurrentPath={(path) => {
            if (ready.current && currentChapter() === index) selectFile(index, path)
          }}
        />
      ))}
    </div>
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

  // Opening or collapsing unmounts the focused control, so focus the one that replaced it.
  useLayoutEffect(() => {
    if (wasCollapsed.current === props.collapsed) return

    wasCollapsed.current = props.collapsed

    if (document.activeElement === null || document.activeElement === document.body)
      toggle.current?.focus({ focusVisible: false })
  }, [props.collapsed])

  return (
    <section
      className={
        props.collapsed
          ? "[&+section]:mt-5"
          : "grid grid-cols-[340px_minmax(0,1fr)] overflow-clip rounded-[10px] border bg-[color-mix(in_oklch,var(--muted)_35%,var(--background))] @max-[850px]/tour:grid-cols-[280px_minmax(0,1fr)] @max-[700px]/tour:grid-cols-1 [&+section]:mt-5"
      }
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
            className="max-h-(--tour-card-height) min-w-0 overflow-y-auto px-6 py-5.5 [scrollbar-width:thin] @max-[850px]/tour:p-4.5 @max-[700px]/tour:max-h-75"
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
            <div className="text-[13px] leading-[1.8] text-muted-foreground wrap-anywhere [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs [&_code]:text-inherit [&_p+p]:mt-3">
              {paragraphs.map((paragraph, index) => (
                <p key={index}>
                  <TourText text={paragraph} />
                </p>
              ))}
            </div>
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
          </aside>
          <div className="flex h-(--tour-card-height) min-h-0 min-w-0 border-l px-4.5 pt-4 pb-4.5 @max-[850px]/tour:p-3.5 @max-[700px]/tour:h-115 @max-[700px]/tour:border-t @max-[700px]/tour:border-l-0">
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

function LineCounts(props: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 gap-1 font-mono text-[10px]">
      {props.deletions > 0 && <span className="text-deleted">−{props.deletions}</span>}
      <span className="text-added">+{props.additions}</span>
    </span>
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

  return (
    <nav className="mt-5.5 flex flex-col gap-1.75" aria-label={`Files in ${props.title}`}>
      {props.files.map(({ file }) => {
        const slash = file.path.lastIndexOf("/")

        return (
          <button
            type="button"
            key={file.path}
            className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-[7px] border bg-background px-2.5 py-2.25 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ring aria-[current=location]:border-(--viewed) aria-[current=location]:bg-[color-mix(in_oklch,var(--viewed)_10%,var(--background))]"
            aria-current={props.path === file.path ? "location" : undefined}
            onClick={() => props.onSelect(file.path)}
            title={file.path}
          >
            <span className="min-w-0 flex-1">
              <span className="block break-all font-mono text-[11px] font-medium">
                {file.path.slice(slash + 1)}
              </span>
              {slash >= 0 && (
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {file.path.slice(0, slash)}
                </span>
              )}
            </span>
            {viewed.viewed.has(file.path) && (
              <Check aria-label="Viewed" className="size-3 shrink-0 text-(--viewed)" />
            )}
            <LineCounts additions={file.additions} deletions={file.deletions} />
          </button>
        )
      })}
    </nav>
  )
}
