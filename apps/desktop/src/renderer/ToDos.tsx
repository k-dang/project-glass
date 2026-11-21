import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  mentionedToDoIds,
  nothingUnsent,
  toDoMention,
  ToDoError,
  type ToDo,
  type ToDoImage,
  type ToDoImageUpload,
} from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { DialogTrigger } from "@ui-sdk/react/dialog"
import { cn } from "cn"
import { AsyncResult, Atom } from "effect/reactivity"
import { Effect, Exit, Option, Stream } from "effect"
import { MessageSquarePlus, Pencil, Trash2, X } from "lucide-react"
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { Backend, backendRuntime, useBackendRuntime } from "./backend"
import { newThreadWrittenAtom } from "./threadsArea"
import { createImageViewer, ImageViewer } from "./ImageViewer"
import { imageFiles, imageSrc, maxToDoImageBytes, readToDoImages } from "./pastedImages"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, settledProblem } from "./problems"
import { shortcutLabel } from "./shortcutLabel"
import { submitOnShortcut } from "./submitShortcut"
import {
  changeAtom,
  pendingToggleAtom,
  savedToDosAtom,
  type ToDoChange,
  toDoThumbnailAtom,
  toDosAtom,
} from "./toDoList"
import { linkLabel, newestFirst, noteParts } from "./toDoOrder"

interface ToDoFields {
  readonly title: string
  readonly notes: string
}

interface DraftImage extends ToDoImageUpload {
  readonly key: number
}

interface NewToDo extends ToDoFields {
  readonly images: ReadonlyArray<DraftImage>
  readonly savedId: number | null
}

const emptyToDo: NewToDo = { title: "", notes: "", images: [], savedId: null }

const unsentAtom = Atom.family((_id: number) => Atom.make<ReadonlyArray<DraftImage>>([]))

const unsentHeldAtom = Atom.family((_id: number) => Atom.make(false))

const sendImagesAtom = Atom.family((id: number) =>
  backendRuntime.fn((added: ReadonlyArray<DraftImage>, get) => {
    get.registry.set(unsentHeldAtom(id), false)
    get.registry.update(unsentAtom(id), (current) => [...current, ...added])

    return Effect.gen(function* () {
      while (true) {
        yield* get.stream(changeAtom).pipe(
          Stream.filter((change) => !change.waiting),
          Stream.runHead,
        )

        const image = get.registry.get(unsentAtom(id))[0]

        if (image === undefined || get.registry.get(unsentHeldAtom(id))) return

        get.set(changeAtom, {
          save: Backend.use((backend) =>
            backend
              .AttachToDoImages({ id, images: [uploadOf(image)] })
              .pipe(
                Effect.tapError(() =>
                  Effect.sync(() => get.registry.set(unsentHeldAtom(id), true)),
                ),
              ),
          ),
          onSaved: () =>
            get.registry.update(unsentAtom(id), (current) =>
              current.filter((queued) => queued.key !== image.key),
            ),
        })
      }
    })
  }),
)

let nextDraftImage = 0

const newToDoAtom = Atom.make<NewToDo>(emptyToDo).pipe(Atom.keepAlive)

const editAtom = Atom.family((_id: number) =>
  Atom.make<ToDoFields | null>(null).pipe(Atom.keepAlive),
)

const uploadOf = ({
  mediaType,
  data,
  thumbnail,
  thumbnailMediaType,
}: DraftImage): ToDoImageUpload => ({
  mediaType,
  data,
  thumbnail,
  thumbnailMediaType,
})

function useToDoChanges() {
  const change = useAtomValue(changeAtom)
  const save = useAtomSet(changeAtom)
  const pending = change.waiting

  const run = (next: ToDoChange) => {
    if (pending) return false

    save(next)

    return true
  }

  return {
    pending,
    problem: settledProblem(change),
    add: (
      draft: NewToDo,
      knownIds: ReadonlyArray<number>,
      onFinished: (remaining: ReadonlyArray<DraftImage>, savedId: number) => void,
    ) => {
      let remaining = draft.images
      let savedId = draft.savedId

      return run({
        save: Effect.gen(function* () {
          const backend = yield* Backend
          const known = new Set(knownIds)

          let list =
            draft.savedId === null
              ? yield* backend.AddToDo({ title: draft.title, notes: draft.notes })
              : yield* backend.ListToDos()

          const id = draft.savedId ?? list.find((toDo) => !known.has(toDo.id))?.id

          if (id === undefined) {
            return yield* Effect.fail(
              new ToDoError({ message: "Couldn't save your to-do. Try again." }),
            )
          }

          const failed: Array<DraftImage> = []

          for (const [index, image] of draft.images.entries()) {
            const exit = yield* Effect.exit(
              backend.AttachToDoImages({ id, images: [uploadOf(image)] }),
            )

            if (Exit.isFailure(exit)) {
              failed.push(...draft.images.slice(index))

              break
            }

            list = exit.value
          }

          remaining = failed
          savedId = id

          return list
        }),
        onSaved: () => {
          if (savedId !== null) onFinished(remaining, savedId)
        },
      })
    },
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
    removeImage: (id: number) =>
      run({ save: Backend.use((backend) => backend.RemoveToDoImage({ id })) }),
  }
}

const largestImage = `${maxToDoImageBytes / 1024 ** 2} MB`

const takePastedImages = (
  event: ClipboardEvent,
  add: (images: ReadonlyArray<DraftImage>) => void,
) => {
  const files = imageFiles(event.clipboardData)

  if (files.length === 0) return

  event.preventDefault()
  void readToDoImages(files).then(({ images, rejected }) => {
    for (const name of rejected) {
      toast.add({
        type: "error",
        title: `${name} is too big to attach`,
        description: `The largest image is ${largestImage}.`,
      })
    }

    if (images.length > 0) add(images.map((image) => ({ ...image, key: ++nextDraftImage })))
  })
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
  const open = newestFirst(props.toDos.filter((toDo) => !toDo.done))
  const done = props.toDos.filter((toDo) => toDo.done)

  return (
    <section aria-label="To-dos" aria-busy={pending} className="flex flex-col gap-4">
      <AddToDo />
      {problem !== null && <ProblemAlert problem={problem} />}
      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to do.</p>
      ) : (
        <ToDoItems label="Open to-dos" toDos={open} />
      )}
      <DoneToDos toDos={done} />
    </section>
  )
}

function DoneToDos(props: { toDos: ReadonlyArray<ToDo> }) {
  if (props.toDos.length === 0) return null

  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted-foreground select-none">
        Done ({props.toDos.length})
      </summary>
      <ToDoItems label="Done to-dos" toDos={props.toDos} className="mt-2" />
    </details>
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

function ImageStrip(props: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={props.label} className="flex flex-wrap gap-2 pt-2">
      {props.children}
    </ul>
  )
}

function AddToDo() {
  const [draft, setDraft] = useAtom(newToDoAtom)
  const listed = useAtomValue(toDosAtom)
  const { pending, add } = useToDoChanges()
  const { title, notes, images, savedId } = draft
  const trimmed = title.trim()
  const [viewer] = useState(createImageViewer)

  const knownIds = Option.match(AsyncResult.value(listed), {
    onNone: () => [],
    onSome: (toDos) => toDos.map((toDo) => toDo.id),
  })

  const onPaste = (event: ClipboardEvent<HTMLFormElement>) =>
    takePastedImages(event, (pasted) =>
      setDraft((current) => ({ ...current, images: [...current.images, ...pasted] })),
    )

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (savedId === null && trimmed === "") return

    const submitted = draft
    add(
      { ...submitted, title: trimmed, notes: notes.trimEnd() },
      knownIds,
      (remaining, createdId) => {
        const sent = new Set(
          submitted.images
            .filter((image) => !remaining.some((failed) => failed.key === image.key))
            .map((image) => image.key),
        )

        setDraft((current) => {
          const imagesLeft = current.images.filter((image) => !sent.has(image.key))

          if (imagesLeft.length === 0) {
            return current.title === submitted.title && current.notes === submitted.notes
              ? emptyToDo
              : { title: current.title, notes: current.notes, images: [], savedId: null }
          }

          return { ...current, images: imagesLeft, savedId: createdId }
        })
      },
    )
  }

  const attachments = (
    <>
      {savedId !== null && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't save every image. Try again.
        </p>
      )}
      {images.length > 0 && (
        <ImageStrip label="Images">
          {images.map((image, index) => (
            <li key={image.key} className="flex items-start gap-0.5">
              <DialogTrigger
                controller={viewer}
                payload={{
                  images: [
                    { src: imageSrc(image.mediaType, image.data), name: `Image ${index + 1}` },
                  ],
                  index: 0,
                }}
                aria-label={`Open image ${index + 1}`}
                className="rounded-md"
              >
                <img
                  src={imageSrc(image.thumbnailMediaType, image.thumbnail)}
                  alt=""
                  className="size-14 rounded-md border object-cover"
                />
              </DialogTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove image ${index + 1}`}
                onClick={() => {
                  const imagesLeft = images.filter((kept) => kept.key !== image.key)

                  setDraft(
                    imagesLeft.length === 0 && savedId !== null
                      ? emptyToDo
                      : { title, notes, images: imagesLeft, savedId },
                  )
                }}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ImageStrip>
      )}
    </>
  )

  const submitLabel = savedId === null ? "Add" : "Try again"
  const submitDisabled = pending || (savedId === null ? trimmed === "" : images.length === 0)

  return (
    <Card render={<form aria-label="Add a to-do" onPaste={onPaste} onSubmit={onSubmit} />}>
      <CardContent className="flex flex-col gap-1">
        <Input
          aria-label="New to-do"
          placeholder="Add a to-do"
          value={title}
          onChange={(event) => setDraft({ title: event.target.value, notes, images, savedId })}
          disabled={savedId !== null}
          className="h-8 border-0 bg-transparent px-0 font-medium shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        />
        <Textarea
          aria-label="Notes"
          placeholder="Notes"
          value={notes}
          onChange={(event) => setDraft({ title, notes: event.target.value, images, savedId })}
          disabled={savedId !== null}
          onKeyDown={submitOnShortcut}
          className="min-h-10 resize-none border-0 bg-transparent px-0 py-1 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        />
        {attachments}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <span className="text-xs text-muted-foreground" aria-hidden>
          {shortcutLabel("↵")}
        </span>
        <Button type="submit" size="sm" disabled={submitDisabled}>
          {submitLabel}
        </Button>
      </CardFooter>
      <ImageViewer controller={viewer} />
    </Card>
  )
}

function UnsentStrip(props: { toDo: ToDo }) {
  const unsent = useAtomValue(unsentAtom(props.toDo.id))
  const held = useAtomValue(unsentHeldAtom(props.toDo.id))
  const sendImages = useAtomSet(sendImagesAtom(props.toDo.id))

  if (unsent.length === 0) return null

  return (
    <div className="mt-2">
      <ImageStrip label={`Images to save on ${props.toDo.title}`}>
        {unsent.map((image, index) => (
          <li key={image.key}>
            <img
              src={imageSrc(image.thumbnailMediaType, image.thumbnail)}
              alt=""
              className="size-14 rounded-md border object-cover"
            />
            <span className="sr-only">Image {index + 1} not saved</span>
          </li>
        ))}
      </ImageStrip>
      {held && (
        <Button type="button" size="sm" className="mt-2" onClick={() => sendImages([])}>
          Try again
        </Button>
      )}
    </div>
  )
}

function CompactNotes(props: { readonly notes: string }) {
  const parts = noteParts(props.notes)

  const text = parts
    .flatMap((part) => (part.kind === "text" ? [part.value] : []))
    .join("")
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/[ \t]{2,}/g, " ")
    .trim()

  const links = parts.flatMap((part, index) =>
    part.kind === "link" ? [{ url: part.value, key: index }] : [],
  )

  if (text === "" && links.length === 0) return null

  return (
    <div className="mt-1 flex flex-col gap-1">
      {text !== "" && (
        <p className="line-clamp-2 text-sm break-words whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      )}
      {links.length > 0 && (
        <ul aria-label="Links" className="flex flex-wrap gap-x-3 gap-y-1">
          {links.map((link) => (
            <li key={link.key}>
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                title={link.url}
                className="text-xs break-all text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {linkLabel(link.url)}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function useStartThread(toDo: ToDo) {
  const navigate = useNavigate()
  const setWritten = useAtomSet(newThreadWrittenAtom)

  return () => {
    setWritten((written) => {
      const composed = written ?? nothingUnsent

      if (mentionedToDoIds(composed.message).includes(toDo.id)) return composed

      const before = composed.message.trimEnd()
      const link = `${toDoMention(toDo)} `

      return { ...composed, message: before === "" ? link : `${before} ${link}` }
    })
    void navigate({ to: "/threads/new" })
  }
}

function ToDoRow(props: { toDo: ToDo }) {
  const { toDo } = props
  const { pending, setDone, remove } = useToDoChanges()
  const [edit, setEdit] = useAtom(editAtom(toDo.id))
  const sendImages = useAtomSet(sendImagesAtom(toDo.id))
  const toggle = useAtomValue(pendingToggleAtom)
  const checked = toggle?.id === toDo.id ? toggle.done : toDo.done
  const startThread = useStartThread(toDo)

  const paste = (event: ClipboardEvent) => takePastedImages(event, sendImages)

  if (edit !== null) {
    return (
      <li className="px-3 py-2">
        <ToDoEditor toDo={toDo} edit={edit} onPaste={paste} />
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
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- The row takes a pasted image once it has focus. */}
      <div
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The row takes a pasted image once it has focus.
        tabIndex={0}
        className="min-w-0 flex-1 py-0.5 outline-none"
        onMouseDown={(event) => {
          if (event.target instanceof Element && event.target.closest("button")) return
          event.currentTarget.focus()
        }}
        onPaste={paste}
      >
        <p className={cn("text-sm break-words", checked && "text-muted-foreground line-through")}>
          {toDo.title}
        </p>
        {toDo.notes !== "" && <CompactNotes notes={toDo.notes} />}
        <SavedImages toDo={toDo} />
        <UnsentStrip toDo={toDo} />
      </div>
      {!toDo.done && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Start a Thread from ${toDo.title}`}
          title="Start a Thread"
          onClick={startThread}
        >
          <MessageSquarePlus aria-hidden />
        </Button>
      )}
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

function ToDoEditor(props: {
  toDo: ToDo
  edit: ToDoFields
  onPaste: (event: ClipboardEvent) => void
}) {
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
      onPaste={props.onPaste}
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
        aria-label={`Notes for ${props.toDo.title}`}
        placeholder="Notes"
        value={notes}
        onChange={(event) => setEdit({ title, notes: event.target.value })}
        onKeyDown={cancelOnEscape}
      />
      <SavedImages toDo={props.toDo} />
      <UnsentStrip toDo={props.toDo} />
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

function useWhenVisible() {
  const [visible, setVisible] = useState(globalThis.IntersectionObserver === undefined)

  const setElement = useCallback(
    (element: HTMLElement | null) => {
      if (element === null || visible || globalThis.IntersectionObserver === undefined) {
        return undefined
      }

      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      })

      observer.observe(element)

      return () => observer.disconnect()
    },
    [visible],
  )

  return { setElement, visible }
}

function SavedImages(props: { toDo: ToDo }) {
  const { removeImage, pending } = useToDoChanges()

  if (props.toDo.images.length === 0) return null

  return (
    <ImageStrip label={`Images of ${props.toDo.title}`}>
      {props.toDo.images.map((image, index) => (
        <SavedImage
          key={image.id}
          image={image}
          title={props.toDo.title}
          index={index}
          pending={pending}
          onRemove={() => removeImage(image.id)}
        />
      ))}
    </ImageStrip>
  )
}

function SavedImage(props: {
  image: ToDoImage
  title: string
  index: number
  pending: boolean
  onRemove: () => void
}) {
  const { setElement, visible } = useWhenVisible()
  const runtime = useBackendRuntime()
  const [viewer] = useState(createImageViewer)
  const number = props.index + 1

  const open = () => {
    void runtime
      .runPromiseExit(
        Backend.use((backend) => backend.ReadToDoImage({ id: props.image.id, size: "full" })),
      )
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          void viewer.open({
            payload: {
              images: [
                { src: imageSrc(exit.value.mediaType, exit.value.data), name: `Image ${number}` },
              ],
              index: 0,
            },
          })

          return
        }

        toast.add({ type: "error", title: "Couldn't open that image" })
      })
  }

  return (
    <li className="flex items-start gap-0.5">
      <button
        type="button"
        ref={setElement}
        aria-label={`Open image ${number} of ${props.title}`}
        className="rounded-md"
        onClick={open}
      >
        {visible ? (
          <ToDoThumbnail id={props.image.id} />
        ) : (
          <span className="block size-14 rounded-md border bg-muted" />
        )}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove image ${number} of ${props.title}`}
        disabled={props.pending}
        onClick={props.onRemove}
      >
        <X aria-hidden />
      </Button>
      <ImageViewer controller={viewer} />
    </li>
  )
}

function ToDoThumbnail(props: { id: number }) {
  const result = useAtomValue(toDoThumbnailAtom(props.id))

  return AsyncResult.builder(result)
    .onInitialOrWaiting(() => <span className="block size-14 rounded-md border bg-muted" />)
    .onFailure(() => <span className="block size-14 rounded-md border bg-muted" />)
    .onSuccess((image) => (
      <img
        src={imageSrc(image.mediaType, image.data)}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-14 rounded-md border object-cover"
      />
    ))
    .render()
}
