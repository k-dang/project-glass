import { ToDo } from "@glass/contracts"
import { Effect, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Backend, type BackendError, backendRuntime } from "./backend"
import { newestFirst } from "./toDoOrder"

export interface ToDoChange {
  readonly save: Effect.Effect<ReadonlyArray<ToDo>, BackendError, Backend>
  readonly onSaved?: () => void
  readonly toggle?: { readonly id: number; readonly done: boolean }
}

export const savedToDosAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchToDos())))
  .pipe(Atom.keepAlive)

export const pendingToggleAtom = Atom.make<ToDoChange["toggle"]>(undefined).pipe(Atom.keepAlive)

export const changeAtom = backendRuntime
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

export const toDosAtom = Atom.make((get) => {
  const toggle = get(pendingToggleAtom)

  return AsyncResult.map(get(savedToDosAtom), (toDos) =>
    toggle === undefined
      ? toDos
      : toDos.map(
          ({ id, title, notes, done, images }) =>
            new ToDo({ id, title, notes, images, done: id === toggle.id ? !toggle.done : done }),
        ),
  )
})

export const openToDosAtom = Atom.make((get) =>
  AsyncResult.map(get(toDosAtom), (toDos) => newestFirst(toDos.filter((toDo) => !toDo.done))),
)

export const toDoThumbnailAtom = Atom.family((id: number) =>
  backendRuntime.atom(Backend.use((backend) => backend.ReadToDoImage({ id, size: "thumbnail" }))),
)
