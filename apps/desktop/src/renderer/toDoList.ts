import type { ToDo } from "@glass/contracts"
import { Effect, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Backend, type BackendError, backendRuntime } from "./backend"

export interface ToDoChange {
  readonly save: Effect.Effect<ReadonlyArray<ToDo>, BackendError, Backend>
  readonly onSaved?: () => void
  readonly toggle?: { readonly id: number; readonly done: boolean }
}

export const savedToDosAtom = backendRuntime
  .atom(Backend.use((backend) => backend.ListToDos()))
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

export const toDosAtom = Atom.make((get) =>
  Option.match(AsyncResult.value(get(changeAtom)), {
    onSome: (saved) => AsyncResult.success(saved),
    onNone: () => get(savedToDosAtom),
  }),
)

export const openToDosAtom = Atom.make((get) =>
  AsyncResult.map(get(toDosAtom), (toDos) => toDos.filter((toDo) => !toDo.done)),
)
