import { useAtom, useAtomValue } from "@effect/atom-react"
import type { ToDo } from "@glass/contracts"
import { cn } from "cn"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { GripVertical } from "lucide-react"
import { type PointerEvent as ReactPointerEvent, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ProblemAlert } from "./ProblemAlert"
import type { Problem } from "./problems"
import { AddToDo, DoneToDos, ToDoItems, ToDoRow, useToDoChanges } from "./ToDos"
import { manualOrderAtom, toDosAtom } from "./toDoList"
import {
  checklistToDos,
  doneToDos,
  moveBefore,
  moveBy,
  newestFirst,
  notedToDos,
  openToDos,
  orderedBy,
  reconcileOrder,
} from "./toDoOrder"

export function NewestToDos(props: {
  readonly toDos: ReadonlyArray<ToDo>
  readonly problem: Problem | null
}) {
  const open = newestFirst(openToDos(props.toDos))
  const done = doneToDos(props.toDos)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">New to-dos land at the top.</p>
      <AddToDo />
      {props.problem !== null && <ProblemAlert problem={props.problem} />}
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to do.</p>
      ) : (
        <ToDoItems label="Open to-dos" toDos={open} notes="compact" />
      )}
      <DoneToDos toDos={done} notes="compact" />
    </div>
  )
}

export function ReorderToDos(props: {
  readonly toDos: ReadonlyArray<ToDo>
  readonly problem: Problem | null
}) {
  const open = openToDos(props.toDos)
  const [stored, setStored] = useAtom(manualOrderAtom)
  const ordered = orderedBy(open, stored)
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | "end" | null>(null)

  const move = (id: number, before: number | null) => {
    setStored((current) => moveBefore(reconcileOrder(open, current), id, before))
    setDragging(null)
    setOver(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Drag a handle to reorder, or focus it and use the arrow keys. New to-dos are added at the
        end.
      </p>
      {props.problem !== null && <ProblemAlert problem={props.problem} />}
      <ul aria-label="Open to-dos" className="divide-y rounded-md border">
        {ordered.map((toDo) => (
          <ToDoRow
            key={toDo.id}
            toDo={toDo}
            notes="compact"
            reorderId={toDo.id}
            className={cn(
              dragging === toDo.id && "opacity-60",
              over === toDo.id && dragging !== toDo.id && "bg-muted/60",
            )}
            leading={
              <ReorderHandle
                id={toDo.id}
                title={toDo.title}
                onDragStart={() => setDragging(toDo.id)}
                onOver={setOver}
                onDrop={(target) => {
                  if (target === null) {
                    setDragging(null)
                    setOver(null)

                    return
                  }

                  move(toDo.id, target === "end" ? null : target)
                }}
                onCancel={() => {
                  setDragging(null)
                  setOver(null)
                }}
                onMove={(delta) =>
                  setStored((current) => moveBy(reconcileOrder(open, current), toDo.id, delta))
                }
              />
            }
          />
        ))}
        <li
          data-reorder-end=""
          className={cn(over === "end" && dragging !== null && "bg-muted/60")}
        >
          <InlineAdd />
        </li>
      </ul>
      <DoneToDos toDos={doneToDos(props.toDos)} notes="compact" />
    </div>
  )
}

const reorderTarget = (x: number, y: number, id: number): number | "end" | null => {
  for (const hit of document.elementsFromPoint(x, y)) {
    if (!(hit instanceof Element)) continue

    if (hit.closest("[data-reorder-end]") !== null) return "end"

    const row = hit.closest("[data-reorder-id]")

    if (!(row instanceof HTMLElement)) continue

    const target = Number(row.dataset["reorderId"])

    if (Number.isInteger(target) && target !== id) return target
  }

  return null
}

function ReorderHandle(props: {
  readonly id: number
  readonly title: string
  readonly onDragStart: () => void
  readonly onOver: (over: number | "end" | null) => void
  readonly onDrop: (target: number | "end" | null) => void
  readonly onCancel: () => void
  readonly onMove: (delta: -1 | 1) => void
}) {
  const track = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return

    props.onOver(reorderTarget(event.clientX, event.clientY, props.id))
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`Reorder ${props.title}`}
      aria-keyshortcuts="ArrowUp ArrowDown"
      className="mt-0.5 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
      onPointerDown={(event) => {
        if (event.button !== 0) return

        event.currentTarget.setPointerCapture(event.pointerId)
        props.onDragStart()
      }}
      onPointerMove={track}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return

        const target = reorderTarget(event.clientX, event.clientY, props.id)
        event.currentTarget.releasePointerCapture(event.pointerId)
        props.onOver(target)
        props.onDrop(target)
      }}
      onPointerCancel={() => props.onCancel()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return

        event.preventDefault()
        props.onMove(event.key === "ArrowUp" ? -1 : 1)
      }}
    >
      <GripVertical aria-hidden />
    </Button>
  )
}

function InlineAdd() {
  const listed = useAtomValue(toDosAtom)
  const { pending, add } = useToDoChanges()
  const [title, setTitle] = useState("")
  const trimmed = title.trim()

  const knownIds = Option.match(AsyncResult.value(listed), {
    onNone: () => [],
    onSome: (toDos) => toDos.map((toDo) => toDo.id),
  })

  return (
    <form
      aria-label="Add a to-do"
      className="flex items-center gap-2 px-3 py-1.5"
      onSubmit={(event) => {
        event.preventDefault()

        if (pending || trimmed === "") return

        const submitted = trimmed
        add({ title: submitted, notes: "", images: [], savedId: null }, knownIds, () => {
          setTitle((current) => (current.trim() === submitted ? "" : current))
        })
      }}
    >
      <Input
        aria-label="New to-do"
        placeholder="Add a to-do"
        value={title}
        disabled={pending}
        onChange={(event) => setTitle(event.target.value)}
        className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
      />
      <Button type="submit" size="sm" disabled={pending || trimmed === ""}>
        Add
      </Button>
    </form>
  )
}

export function SectionToDos(props: {
  readonly toDos: ReadonlyArray<ToDo>
  readonly problem: Problem | null
}) {
  const open = openToDos(props.toDos)
  const checklist = checklistToDos(open)
  const noted = notedToDos(open)
  const done = doneToDos(props.toDos)

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Title-only to-dos stay in the order you added them. Ones with notes are newest first.
      </p>
      <AddToDo variant="bar" />
      {props.problem !== null && <ProblemAlert problem={props.problem} />}
      <ToDoGroup
        label="Checklist"
        hint="Added order"
        toDos={checklist}
        empty={noted.length === 0 ? "Nothing to do." : "No title-only to-dos."}
      />
      <ToDoGroup label="With notes" hint="Newest first" toDos={noted} empty="No notes yet." />
      {done.length > 0 && (
        <ToDoGroup label="Done" hint="Recently finished" toDos={done} listLabel="Done to-dos" />
      )}
    </div>
  )
}

function ToDoGroup(props: {
  readonly label: string
  readonly hint: string
  readonly toDos: ReadonlyArray<ToDo>
  readonly empty?: string
  readonly listLabel?: string
}) {
  return (
    <section aria-label={props.label} className="flex flex-col gap-1">
      <h2 className="flex items-baseline gap-2 px-1 text-xs font-medium text-muted-foreground">
        <span>{props.label}</span>
        <span className="tabular-nums">{props.toDos.length}</span>
        <span className="font-normal">{props.hint}</span>
      </h2>
      {props.toDos.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">{props.empty}</p>
      ) : (
        <ToDoItems label={props.listLabel ?? props.label} toDos={props.toDos} notes="compact" />
      )}
    </section>
  )
}
