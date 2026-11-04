import type { TourCallTree as CallTree, TourCodeTarget } from "@glass/contracts"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

export function TourCallTree(props: {
  tree: CallTree
  chapterTitle: string
  onSelect: (target: TourCodeTarget) => void
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const children = Map.groupBy(props.tree, (node) => node.parent)

  const branch = (node: CallTree[number]): ReactNode => {
    const nested = children.get(node.id) ?? []
    const open = !collapsed.has(node.id)
    const source = `${node.target.path}:${node.target.startLine}`

    return (
      <li key={node.id}>
        <div className="flex min-w-0 items-start gap-1">
          {nested.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="mt-1 shrink-0"
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} calls from ${node.label}`}
              onClick={() =>
                setCollapsed((before) => {
                  const next = new Set(before)

                  if (open) next.add(node.id)
                  else next.delete(node.id)

                  return next
                })
              }
            >
              {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            </Button>
          ) : (
            <span className="w-6 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            aria-pressed={selected === node.id}
            title={`${source} (${node.target.side})`}
            className="min-w-0 flex-1 cursor-pointer rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:bg-accent"
            onClick={() => {
              setSelected(node.id)
              props.onSelect(node.target)
            }}
          >
            <span className="block text-xs font-medium wrap-anywhere">
              {node.change === "added" && <span className="text-added">+ </span>}
              {node.change === "removed" && <span className="text-deleted">− </span>}
              {node.label}
              <span className="sr-only">, {node.change}. Show code.</span>
            </span>
            <span className="block font-mono text-[10px] text-muted-foreground wrap-anywhere">
              {source}
            </span>
          </button>
        </div>
        {nested.length > 0 && open && <ul className="ml-1 border-l pl-1">{nested.map(branch)}</ul>}
      </li>
    )
  }

  return (
    <section className="my-5" aria-label={`Call tree for ${props.chapterTitle}`}>
      <h3 className="mb-2 text-xs font-medium">Call tree</h3>
      <ul>{branch(props.tree[0]!)}</ul>
    </section>
  )
}
