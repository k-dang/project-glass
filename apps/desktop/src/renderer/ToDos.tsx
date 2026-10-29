import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { ToDo } from "@glass/contracts"
import { cn } from "cn"
import { Effect, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Pencil, Trash2 } from "lucide-react"
import type { KeyboardEvent } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { Backend, type BackendError, backendRuntime } from "./backend"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, settledProblem } from "./problems"

interface ToDoChange {
  readonly save: Effect.Effect<ReadonlyArray<ToDo>, BackendError, Backend>
  readonly onSaved?: () => void
  readonly toggle?: { readonly id: number; readonly done: boolean }
}

const savedToDosAtom = backendRuntime
  .atom(Backend.use((backend) => backend.ListToDos()))
  .pipe(Atom.keepAlive)

const newTitleAtom = Atom.make("").pipe(Atom.keepAlive)

interface ToDoEdit {
  readonly title: string
  readonly notes: string
}

const editAtom = Atom.family((_id: number) => Atom.make<ToDoEdit | null>(null).pipe(Atom.keepAlive))

const pendingToggleAtom = Atom.make<ToDoChange["toggle"]>(undefined).pipe(Atom.keepAlive)

const changeAtom = backendRuntime
  .fn((change: ToDoChange, get) =>
    Effect.gen(function* () {
      get.set(pendingToggleAtom, change.toggle)

      const { saved } = yield* Effect.all(
        {
          saved: change.save,
          feedback: change.toggle?.done ? Effect.sleep("250 millis") : Effect.void,
        },
        { concurrency: "unbounded" },
      )

      change.onSaved?.()

      return saved
    }).pipe(Effect.ensuring(Effect.sync(() => get.set(pendingToggleAtom, undefined)))),
  )
  .pipe(Atom.keepAlive)

const toDosAtom = Atom.make((get) =>
  Option.match(AsyncResult.value(get(changeAtom)), {
    onSome: (saved) => AsyncResult.success(saved),
    onNone: () => get(savedToDosAtom),
  }),
)

function useToDoChanges() {
  const change = useAtomValue(changeAtom)
  const save = useAtomSet(changeAtom)
  const pending = change.waiting

  const run = (next: ToDoChange) => {
    if (!pending) save(next)
  }

  return {
    pending,
    problem: settledProblem(change),
    add: (title: string, onSaved: () => void) =>
      run({ save: Backend.use((backend) => backend.AddToDo({ title })), onSaved }),
    edit: (id: number, title: string, notes: string, onSaved: () => void) =>
      run({ save: Backend.use((backend) => backend.EditToDo({ id, title, notes })), onSaved }),
    setDone: (toDo: ToDo, done: boolean) =>
      run({
        save: Backend.use((backend) => backend.SetToDoDone({ id: toDo.id, done })),
        toggle: { id: toDo.id, done },
        onSaved: () => {
          toast.add({
            type: "success",
            title: done ? "To-do completed" : "To-do reopened",
            description: toDo.title,
            timeout: 2500,
          })
        },
      }),
    remove: (id: number) => run({ save: Backend.use((backend) => backend.DeleteToDo({ id })) }),
  }
}

export function ToDos() {
  const toDos = useAtomValue(toDosAtom)
  const retry = useAtomRefresh(savedToDosAtom)

  return (
    <div className="page-content flex flex-col gap-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">To-dos</h1>
      {AsyncResult.builder(toDos)
        .onInitialOrWaiting(() => <output>Loading to-dos…</output>)
        .onFailure((cause) => (
          <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: retry }} />
        ))
        .onSuccess((value) => <ToDoList toDos={value} />)
        .render()}
    </div>
  )
}

function ToDoList(props: { toDos: ReadonlyArray<ToDo> }) {
  const { pending, problem } = useToDoChanges()
  const open = props.toDos.filter((toDo) => !toDo.done)
  const done = props.toDos.filter((toDo) => toDo.done)

  return (
    <section aria-label="To-dos" aria-busy={pending} className="flex flex-col gap-4">
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to do.</p>
      ) : (
        <ToDoItems label="Open to-dos" toDos={open} />
      )}
      <AddToDo />
      {problem !== null && <ProblemAlert problem={problem} />}
      {done.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground select-none">
            Done ({done.length})
          </summary>
          <ToDoItems label="Done to-dos" toDos={done} className="mt-2" />
        </details>
      )}
    </section>
  )
}

function ToDoItems(props: { label: string; toDos: ReadonlyArray<ToDo>; className?: string }) {
  return (
    <ul aria-label={props.label} className={cn("divide-y rounded-md border", props.className)}>
      {props.toDos.map((toDo) => (
        <ToDoRow key={toDo.id} toDo={toDo} />
      ))}
    </ul>
  )
}

function AddToDo() {
  const [title, setTitle] = useAtom(newTitleAtom)
  const { pending, add } = useToDoChanges()
  const trimmed = title.trim()

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()

        if (trimmed !== "") add(trimmed, () => setTitle((typed) => (typed === title ? "" : typed)))
      }}
    >
      <Input
        aria-label="New to-do"
        placeholder="Add a to-do"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Button type="submit" disabled={pending || trimmed === ""}>
        Add
      </Button>
    </form>
  )
}

function ToDoRow(props: { toDo: ToDo }) {
  const { toDo } = props
  const { pending, setDone, remove } = useToDoChanges()
  const [edit, setEdit] = useAtom(editAtom(toDo.id))
  const toggle = useAtomValue(pendingToggleAtom)
  const checked = toggle?.id === toDo.id ? toggle.done : toDo.done

  if (edit !== null) {
    return (
      <li className="px-3 py-2">
        <ToDoEditor toDo={toDo} edit={edit} />
      </li>
    )
  }

  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <Checkbox
        aria-label={toDo.title}
        className="mt-1"
        checked={checked}
        disabled={pending}
        onCheckedChange={(nextChecked) => setDone(toDo, nextChecked)}
      />
      <div className="min-w-0 flex-1 py-0.5">
        <p className={cn("text-sm break-words", checked && "text-muted-foreground line-through")}>
          {toDo.title}
        </p>
        {toDo.notes !== "" && (
          <p className="mt-1 text-sm break-words whitespace-pre-wrap text-muted-foreground">
            {toDo.notes}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Edit ${toDo.title}`}
        title="Edit"
        disabled={pending}
        onClick={() => setEdit({ title: toDo.title, notes: toDo.notes })}
      >
        <Pencil aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete ${toDo.title}`}
        title="Delete"
        disabled={pending}
        onClick={() => remove(toDo.id)}
      >
        <Trash2 aria-hidden />
      </Button>
    </li>
  )
}

const focusOnMount = (element: HTMLInputElement | null) => element?.focus()

function ToDoEditor(props: { toDo: ToDo; edit: ToDoEdit }) {
  const { pending, edit } = useToDoChanges()
  const setEdit = useAtomSet(editAtom(props.toDo.id))
  const { title, notes } = props.edit
  const trimmed = title.trim()
  const close = () => setEdit(null)

  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") close()
  }

  return (
    <form
      aria-label={`Edit ${props.toDo.title}`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()

        if (trimmed === "") return

        const submitted = props.edit
        edit(props.toDo.id, trimmed, notes.trimEnd(), () =>
          setEdit((current) => (current === submitted ? null : current)),
        )
      }}
    >
      <Input
        aria-label="Title"
        value={title}
        ref={focusOnMount}
        onChange={(event) => setEdit({ title: event.target.value, notes })}
        onKeyDown={cancelOnEscape}
      />
      <Textarea
        aria-label="Notes"
        placeholder="Notes"
        value={notes}
        onChange={(event) => setEdit({ title, notes: event.target.value })}
        onKeyDown={cancelOnEscape}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || trimmed === ""}>
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
