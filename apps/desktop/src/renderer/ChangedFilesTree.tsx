import { useAtomValue } from "@effect/atom-react"
import { TooltipHint } from "@/components/ui/tooltip"
import type { ChangedFile, ChangeType } from "@glass/contracts"
import { type FileTreeRowDecorationRenderer, preparePresortedFileTreeInput } from "@pierre/trees"
import { FileTree, useFileTree } from "@pierre/trees/react"
import { cn } from "cn"
import { Atom } from "effect/reactivity"
import { Filter } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { ChangesLayout } from "./changesView"
import { plural } from "./plural"
import type { ViewedFilesState, ViewedFilesStore } from "./useViewedFiles"

const fileDecoration =
  (
    files: ReadonlyMap<string, ChangedFile>,
    viewedFiles: TreeViewedFiles | null,
    state: ViewedFilesState,
  ): FileTreeRowDecorationRenderer =>
  ({ item }) => {
    const file = files.get(item.path)

    if (file === undefined) return null

    const hasCounts = file.additions + file.deletions > 0
    const viewed = state.viewed.has(file.path)

    const changes = hasCounts ? `+${file.additions} −${file.deletions}` : ""

    const decoration = {
      text: changes,
      title: `${plural(file.additions, "addition")}, ${plural(file.deletions, "deletion")}`,
    }

    return viewedFiles === null
      ? decoration
      : {
          ...decoration,
          checkbox: {
            label: `Viewed: ${file.path}`,
            title: viewed ? "Mark as not viewed" : "Mark as viewed",
            checked: viewed,
            disabled: state.locked,
            onChange: (checked: boolean) => viewedFiles.onChange([file.path], checked),
          },
        }
  }

interface TreeViewedFiles {
  readonly store: ViewedFilesStore
  readonly onChange: (paths: ReadonlyArray<string>, viewed: boolean) => void
}

const noViewedFiles: ViewedFilesState = {
  viewed: new Set(),
  saving: new Set(),
  locked: false,
  failures: new Map(),
}

const nothingViewed = Atom.make(noViewedFiles)

export function ChangedFilesTree(props: {
  layout: ChangesLayout
  onSelect: (path: string, behavior: "instant" | "smooth") => void
  viewedFiles: TreeViewedFiles | null
}) {
  const { layout, onSelect } = props
  const files = layout.files.map((entry) => entry.file)

  const filesByPath = useMemo(
    () => new Map(layout.files.map(({ file }) => [file.path, file])),
    [layout],
  )

  const viewedAtom: Atom.Atom<ViewedFilesState> =
    props.viewedFiles?.store.stateAtom ?? nothingViewed

  const viewed = useAtomValue(viewedAtom)
  const [shown, setShown] = useState<ReadonlySet<ChangeType>>(new Set())
  // Trees reports selection changes without the input event.
  const selectionBehavior = useRef<"instant" | "smooth">("instant")

  const offered = changeTypes.flatMap((entry) => {
    const count = files.filter((file) => file.changeType === entry.type).length

    return count > 0 ? [{ ...entry, count }] : []
  })

  const filterable = offered.length > 1

  const { model } = useFileTree({
    preparedInput: layout.tree,
    gitStatus: files.map((file) => ({ path: file.path, status: file.changeType })),
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    density: "compact",
    stickyFolders: true,
    search: true,
    renderRowDecoration: fileDecoration(filesByPath, props.viewedFiles, viewed),
    unsafeCSS: `
      ${filterable ? "[data-file-tree-search-container] { padding-right: 40px; }" : ""}
      [data-file-tree-virtualized-sticky] { will-change: auto; }
      [data-item-section="content"] { flex: 1 1 auto; }
      [data-item-section="decoration"] {
        flex: 0 0 auto; white-space: nowrap; order: 1;
        color: var(--muted-foreground); font-variant-numeric: tabular-nums;
      }
      [data-item-type="file"] [data-item-section="content"] { color: var(--foreground); }
      [data-item-type="folder"] { color: var(--foreground); font-weight: 500; }
      [data-item-contains-git-change="true"] > [data-item-section="git"] { display: none; }
      [data-row-checkbox] {
        display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; margin-left: 4px; padding: 0;
        border: 0; border-radius: 4px; background: transparent;
        color: var(--muted-foreground); cursor: pointer;
      }
      [data-row-checkbox="true"] { color: var(--viewed); }
      [data-row-checkbox]:hover { background: var(--accent); }
      [data-row-checkbox]:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
      [data-row-checkbox]:disabled { cursor: default; opacity: .5; }
      [data-row-checkbox-empty] {
        width: 13px; height: 13px; border: 1px solid var(--muted-foreground);
        border-radius: 3px; opacity: .35;
      }
      [data-item-path]:hover [data-row-checkbox-empty],
      [data-row-checkbox]:focus-visible [data-row-checkbox-empty] { opacity: 1; }
      [data-item-type="file"]:has([data-row-checkbox="true"]) [data-item-section="content"] {
        color: var(--muted-foreground);
      }
    `,
    onSelectionChange: ([path]) => {
      if (path !== undefined && filesByPath.has(path)) onSelect(path, selectionBehavior.current)
    },
  })

  useLayoutEffect(() => {
    model.setRowDecoration(fileDecoration(filesByPath, props.viewedFiles, viewed))
  }, [model, filesByPath, props.viewedFiles, viewed])

  const show = (types: ReadonlySet<ChangeType>) => {
    setShown(types)

    const paths = layout.tree.paths.filter(
      (path) => types.size === 0 || types.has(filesByPath.get(path)!.changeType),
    )

    model.resetPaths({ preparedInput: preparePresortedFileTreeInput(paths) })
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col pt-2">
      {filterable && (
        <div className="absolute top-2.25 right-3 z-10">
          <ChangeTypeFilter offered={offered} shown={shown} onShownChange={show} />
        </div>
      )}
      <FileTree
        model={model}
        onKeyDownCapture={() => {
          selectionBehavior.current = "instant"
        }}
        // Trees does not fire onSelectionChange when the selected row is clicked again.
        onClickCapture={(event) => {
          selectionBehavior.current = event.detail === 0 ? "instant" : "smooth"

          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return

          if (
            event.nativeEvent
              .composedPath()
              .some((node) => node instanceof HTMLElement && node.hasAttribute("data-row-checkbox"))
          )
            return

          const [path, ...others] = model.getSelectedPaths()

          if (path === undefined || others.length > 0 || !filesByPath.has(path)) return

          const clickedSelected = event.nativeEvent
            .composedPath()
            .some((node) => node instanceof HTMLElement && node.dataset.itemPath === path)

          if (clickedSelected) onSelect(path, selectionBehavior.current)
        }}
        className="file-tree min-h-0 flex-1"
      />
    </div>
  )
}

const changeTypes: ReadonlyArray<{
  readonly type: ChangeType
  readonly letter: string
  readonly label: string
  readonly className: string
}> = [
  { type: "added", letter: "A", label: "Added", className: "text-added" },
  { type: "modified", letter: "M", label: "Modified", className: "text-modified" },
  { type: "renamed", letter: "R", label: "Renamed", className: "text-modified" },
  { type: "deleted", letter: "D", label: "Deleted", className: "text-deleted" },
]

function ChangeTypeFilter(props: {
  offered: ReadonlyArray<(typeof changeTypes)[number] & { readonly count: number }>
  shown: ReadonlySet<ChangeType>
  onShownChange: (shown: ReadonlySet<ChangeType>) => void
}) {
  const { offered, shown, onShownChange } = props

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={
              shown.size === 0
                ? "Filter by change type"
                : `Filter by change type, ${shown.size} chosen`
            }
            title="Filter by change type"
            className="relative"
          />
        }
      >
        <Filter aria-hidden />
        {shown.size > 0 && (
          <span
            aria-hidden
            className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground ring-2 ring-background"
          />
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 gap-0 p-1">
        <p className="px-2 py-1 text-xs text-muted-foreground">Show change types</p>
        {offered.map(({ type, letter, label, className, count }) => {
          const id = `change-type-${type}`

          return (
            <TooltipHint key={type} content={`Alt-click to show only ${label.toLowerCase()} files`}>
              <Label
                htmlFor={id}
                className="cursor-pointer rounded-md px-2 py-1.5 font-normal hover:bg-muted"
              >
                <Checkbox
                  id={id}
                  checked={shown.has(type)}
                  onCheckedChange={(_, { event }) => {
                    if (event instanceof MouseEvent && event.altKey) {
                      onShownChange(
                        shown.size === 1 && shown.has(type) ? new Set() : new Set([type]),
                      )

                      return
                    }

                    const next = new Set(shown)

                    if (!next.delete(type)) next.add(type)

                    onShownChange(next)
                  }}
                />
                <span aria-hidden className={cn("w-3 font-mono text-xs font-semibold", className)}>
                  {letter}
                </span>
                {label}
                <span className="ml-auto text-muted-foreground tabular-nums">{count}</span>
              </Label>
            </TooltipHint>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
