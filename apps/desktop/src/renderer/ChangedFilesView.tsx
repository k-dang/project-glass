import type { DiffSide, LineDiscussion } from "@glass/contracts"
import type {
  CodeViewItem,
  DiffIndicators,
  DiffLineAnnotation,
  FileDiffContentsLoader,
} from "@pierre/diffs"
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react"
import { ChevronDown, ChevronRight, Plus } from "lucide-react"
import { flushSync } from "react-dom"
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { lineOptions } from "./codeCard"
import { DiscussionThread } from "./Discussions"
import { LineAsk } from "./Asks"
import { LineDraft } from "./Drafts"
import {
  type CollapseChoices,
  inHunk,
  type LineNote,
  type LineNotes,
  type ParsedFile,
  toItems,
} from "./changesView"
import { TourText } from "./TourText"
import { cn } from "cn"
import { type AskStore, useLineAskPlaces } from "./useAsks"
import { type DraftStore, useLineDraftPlaces } from "./useDrafts"
import type { ReplyStore } from "./useReplies"
import type { Resolutions } from "./useResolutions"
import { type ViewedFilesStore, useViewedFiles } from "./useViewedFiles"

export interface Display {
  readonly diffStyle: "unified" | "split"
  readonly wrap: boolean
  readonly lineNumbers: boolean
  readonly backgrounds: boolean
  readonly indicators: DiffIndicators
}

export const defaultDisplay: Display = {
  diffStyle: "unified",
  wrap: true,
  lineNumbers: true,
  backgrounds: true,
  indicators: "bars",
}

interface HoveredLine {
  readonly lineNumber: number
  readonly side?: DiffLineAnnotation<LineNote>["side"]
}

export type ViewHandle = CodeViewHandle<LineNote, undefined>

export function useOpenedFiles(viewOf: (path: string) => ViewHandle | null) {
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map())

  const setFilesOpen = useCallback(
    (paths: ReadonlyArray<string>, open: boolean) => {
      const above = open
        ? undefined
        : paths.find((path) => {
            const viewer = viewOf(path)?.getInstance()
            const top = viewer?.getTopForItem(path)

            return viewer !== undefined && top !== undefined && top < viewer.getScrollTop()
          })

      flushSync(() =>
        setOpened((previous) => {
          const next = new Map(previous)

          for (const path of paths) next.set(path, open)

          return next
        }),
      )

      if (above !== undefined) viewOf(above)?.scrollTo({ type: "item", id: above, align: "start" })
    },
    [viewOf],
  )

  return { opened, setOpened, setFilesOpen }
}

const hideHeaderCounts = "[data-additions-count], [data-deletions-count] { display: none; }"

interface DiffViewProps {
  initialPath: string | null
  files: ReadonlyArray<ParsedFile>
  notes: LineNotes
  display: Display
  loadDiffFiles?: FileDiffContentsLoader
  opened: CollapseChoices["opened"]
  all: CollapseChoices["all"]
  onOpenChange: (path: string, open: boolean) => void
  onCurrentPathChange: (path: string) => void
  summaries: ReadonlyMap<string, string> | null
  searchGroup?: CodeViewReactOptions<LineNote, undefined>["searchGroup"]
  renderAnnotation: (annotation: DiffLineAnnotation<LineNote>) => ReactNode
  renderGutterUtility:
    | ((getHoveredLine: () => HoveredLine | undefined, item: CodeViewItem<LineNote>) => ReactNode)
    | null
  renderFileActions?: (path: string) => ReactNode
  ref: RefObject<ViewHandle | null>
}

const noNotes: LineNotes = { discussions: [], drafts: [], asks: [] }

const renderNothing = () => null

export function ReadOnlyDiffView(
  props: Omit<
    DiffViewProps,
    "notes" | "summaries" | "renderAnnotation" | "renderGutterUtility" | "searchGroup"
  >,
) {
  return (
    <DiffView
      {...props}
      notes={noNotes}
      summaries={null}
      renderAnnotation={renderNothing}
      renderGutterUtility={null}
    />
  )
}

function DiffView(props: DiffViewProps) {
  const { files, opened, onOpenChange, summaries, onCurrentPathChange, ref, display } = props
  const { renderFileActions, notes } = props
  const parsed = useMemo(() => new Map(files.map((entry) => [entry.file.path, entry])), [files])
  const [initialPath] = useState(props.initialPath)
  const ready = useRef(false)

  useLayoutEffect(() => {
    if (initialPath !== null) {
      ref.current?.scrollTo({ type: "item", id: initialPath, align: "start", behavior: "instant" })
    }

    ready.current = true
  }, [initialPath, ref])

  const inTour = summaries !== null

  const leads = useMemo(
    () =>
      new Map(
        files.flatMap(({ file }) => (summaries?.has(file.path) ? [[file.path, 48] as const] : [])),
      ),
    [files, summaries],
  )

  const items = useMemo(
    () => toItems(files, notes, { opened, all: props.all }, leads),
    [files, notes, opened, props.all, leads],
  )

  const options = useMemo((): CodeViewReactOptions<LineNote, undefined> => {
    const lines = lineOptions(display.wrap)

    const codeOptions: CodeViewReactOptions<LineNote, undefined> = {
      ...lines,
      unsafeCSS: `${lines.unsafeCSS ?? ""} ${hideHeaderCounts}`,
      diffStyle: display.diffStyle,
      disableLineNumbers: !display.lineNumbers,
      disableBackground: !display.backgrounds,
      diffIndicators: display.indicators,
      lineHoverHighlight: "number",
      layout: { paddingTop: 0, paddingBottom: 0, gap: inTour ? 12 : 1 },
      hunkSeparators: "line-info-basic",
      stickyHeaders: true,
      enableGutterUtility: props.renderGutterUtility !== null,
      enableLineSelection: true,
      onPostRender: (_node, _instance, _phase, context) => {
        const viewer = ref.current?.getInstance()

        if (context.type !== "diff" || context.item.collapsed || viewer === undefined) return

        const bottom =
          context.top + context.height + (viewer.getContainerElement()?.clientHeight ?? 0)

        for (let index = context.index + 1; index < files.length; index++) {
          const next = files[index]!
          const top = viewer.getTopForItem(next.file.path)

          if (top === undefined || top >= bottom) break

          if (next.placeholder === null && viewer.getItem(next.file.path)?.collapsed !== true) {
            void context.instance.primeHighlightCache(next.fileDiff)
          }
        }
      },
    }

    if (props.loadDiffFiles !== undefined) codeOptions.loadDiffFiles = props.loadDiffFiles

    if (props.searchGroup !== undefined) codeOptions.searchGroup = props.searchGroup

    return codeOptions
  }, [
    display,
    props.loadDiffFiles,
    props.searchGroup,
    props.renderGutterUtility,
    files,
    ref,
    inTour,
  ])

  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<LineNote>) => {
      const entry = parsed.get(item.id)

      if (entry === undefined) return null

      if (entry.placeholder !== null) return <span className="block size-6" aria-hidden />

      const collapsed = item.collapsed ?? false
      const Chevron = collapsed ? ChevronRight : ChevronDown

      return (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onOpenChange(item.id, collapsed)}
          aria-label={collapsed ? `Show ${item.id}` : `Hide ${item.id}`}
          aria-expanded={!collapsed}
          className="text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground"
        >
          <Chevron className="size-4" aria-hidden />
        </Button>
      )
    },
    [parsed, onOpenChange],
  )

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<LineNote>) => {
      const entry = parsed.get(item.id)

      if (entry === undefined) return null

      const { additions, deletions } = entry.file

      return (
        <span className="flex items-center gap-[1ch]">
          {entry.placeholder !== null && (
            <span className="text-muted-foreground">{entry.placeholder}</span>
          )}
          {(deletions > 0 || additions === 0) && (
            <span className="font-mono text-(--diffs-deletion-base)">-{deletions}</span>
          )}
          {(additions > 0 || deletions === 0) && (
            <span className="font-mono text-(--diffs-addition-base)">+{additions}</span>
          )}
          {renderFileActions?.(item.id)}
        </span>
      )
    },
    [parsed, renderFileActions],
  )

  const renderItemLead = useCallback(
    (item: CodeViewItem<LineNote>) => {
      const summary = summaries?.get(item.id)

      return summary === undefined ? null : (
        <p className="m-0 bg-[color-mix(in_oklch,var(--muted)_35%,var(--background))] px-0.5 pb-3 text-[13px] leading-[1.7] text-muted-foreground wrap-anywhere">
          <TourText text={summary} />
        </p>
      )
    },
    [summaries],
  )

  const onScroll = useCallback(
    (
      scrollTop: number,
      viewer: { getTopForItem: (id: string) => number | undefined; getHeight: () => number },
    ) => {
      if (!ready.current || items.length === 0) return

      let low = 0
      let high = items.length - 1

      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const top = viewer.getTopForItem(items[middle]!.id) ?? Infinity

        if (top <= scrollTop + (inTour ? viewer.getHeight() / 4 : 1)) low = middle
        else high = middle - 1
      }

      onCurrentPathChange(items[low]!.id)
    },
    [items, onCurrentPathChange, inTour],
  )

  return (
    <CodeView
      ref={ref}
      items={items}
      options={options}
      renderHeaderPrefix={renderHeaderPrefix}
      renderHeaderMetadata={renderHeaderMetadata}
      renderItemLead={renderItemLead}
      renderAnnotation={props.renderAnnotation}
      renderGutterUtility={props.renderGutterUtility ?? renderNothing}
      onScroll={onScroll}
      onRevealSearchMatch={(item) => onOpenChange(item.id, true)}
      className={cn(
        "min-h-0 min-w-0 flex-1 overflow-auto outline-none [&_diffs-container]:overflow-clip",
        inTour
          ? "[scrollbar-width:thin] [&_diffs-container]:rounded-t-[6px] [&_diffs-container]:bg-transparent"
          : "border-t [&_diffs-container]:shadow-[0_1px_0_var(--border)]",
      )}
    />
  )
}

export interface ChangedFilesViewProps extends Omit<
  DiffViewProps,
  "notes" | "loadDiffFiles" | "renderAnnotation" | "renderGutterUtility" | "renderFileActions"
> {
  discussions: ReadonlyArray<LineDiscussion>
  drafts: DraftStore
  asks: AskStore
  replies: ReplyStore
  resolutions: Resolutions
  onReload: () => void
  viewedFiles: ViewedFilesStore
  onViewedChange: (paths: ReadonlyArray<string>, viewed: boolean) => void
  loadDiffFiles: FileDiffContentsLoader
}

export function ChangedFilesView(props: ChangedFilesViewProps) {
  const { discussions, drafts, asks, replies, resolutions, ...rest } = props
  const { onReload, viewedFiles, onViewedChange, ...diff } = rest
  const draftPlaces = useLineDraftPlaces(drafts)
  const askPlaces = useLineAskPlaces(asks)

  const notes = useMemo(
    (): LineNotes => ({ discussions, drafts: draftPlaces, asks: askPlaces }),
    [discussions, draftPlaces, askPlaces],
  )

  const renderGutterUtility = useCallback(
    (getHoveredLine: () => HoveredLine | undefined, item: CodeViewItem<LineNote>) => (
      <Button
        type="button"
        aria-label="Start a Draft on this line"
        title="Comment on this line, or ask the agent about it"
        className="relative z-4 -mr-[calc(1lh-1ch)] size-[1lh] rounded-[4px] border-0 bg-(--diffs-modified-base) p-0 text-(--diffs-bg) hover:bg-(--diffs-modified-base)"
        onClick={() => {
          const hovered = getHoveredLine()

          if (hovered === undefined || item.type !== "diff") return

          const side: DiffSide = hovered.side === "deletions" ? "old" : "new"

          if (inHunk(item.fileDiff, side, hovered.lineNumber)) {
            drafts.start(item.id, side, hovered.lineNumber)
          }
        }}
      >
        <Plus className="size-3.5" aria-hidden />
      </Button>
    ),
    [drafts],
  )

  const renderFileActions = useCallback(
    (path: string) => <ViewedCheckbox path={path} store={viewedFiles} onChange={onViewedChange} />,
    [viewedFiles, onViewedChange],
  )

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<LineNote>) =>
      renderNote(annotation.metadata, {
        drafts,
        asks,
        replies,
        resolutions,
        onReload,
      }),
    [drafts, asks, replies, resolutions, onReload],
  )

  return (
    <DiffView
      {...diff}
      notes={notes}
      renderAnnotation={renderAnnotation}
      renderGutterUtility={renderGutterUtility}
      renderFileActions={renderFileActions}
    />
  )
}

interface NoteContext {
  readonly drafts: DraftStore
  readonly asks: AskStore
  readonly replies: ReplyStore
  readonly resolutions: Resolutions
  readonly onReload: () => void
}

function renderNote(note: LineNote, context: NoteContext) {
  const { drafts, asks, replies, resolutions, onReload } = context

  if (note.type === "ask") {
    return (
      <div className="px-3 py-2">
        <LineAsk store={asks} askKey={note.key} />
      </div>
    )
  }

  if (note.type === "draft") {
    return (
      <div className="px-3 py-2">
        <LineDraft
          store={drafts}
          draftKey={note.key}
          onReload={onReload}
          onAsk={() => {
            const taken = drafts.takeLocal(note.key)

            if (taken !== undefined) asks.ask(taken.place, taken.body)
          }}
        />
      </div>
    )
  }

  return (
    <div className="px-3 py-2">
      <DiscussionThread discussion={note.discussion} replies={replies} resolutions={resolutions} />
    </div>
  )
}

function ViewedCheckbox(props: {
  path: string
  store: ViewedFilesStore
  onChange: (paths: ReadonlyArray<string>, viewed: boolean) => void
}) {
  const viewed = useViewedFiles(props.store)
  const id = useId()

  return (
    <Label
      htmlFor={id}
      className="shrink-0 cursor-pointer text-xs font-normal has-disabled:cursor-default has-disabled:opacity-50"
    >
      <Checkbox
        id={id}
        className="data-checked:border-(--viewed) data-checked:bg-(--viewed) data-checked:text-background dark:data-checked:bg-(--viewed)"
        checked={viewed.viewed.has(props.path)}
        disabled={viewed.locked}
        aria-label={`Viewed: ${props.path}`}
        aria-busy={viewed.saving.has(props.path)}
        onCheckedChange={(checked) => props.onChange([props.path], checked)}
      />
      Viewed
    </Label>
  )
}
