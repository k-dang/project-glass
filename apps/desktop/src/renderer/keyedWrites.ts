import { Effect, Exit, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { type Backend, type BackendError, backendRuntime } from "./backend"
import { type Problem, problemOf } from "./problems"

export type WriteFeedback<Input> =
  | { readonly type: "sending"; readonly input: Input }
  | { readonly type: "failed"; readonly input: Input; readonly problem: Problem }

export interface WriteView<Input, Value> {
  /** What GitHub last answered, until the workspace reloads with fresher data. */
  readonly confirmed: Value | undefined
  readonly feedback: WriteFeedback<Input> | null
}

/**
 * Writes that publish to GitHub right away, one at a time per id (a Discussion or a comment).
 * Reload locks them and waits for those in flight, so the fresh workspace includes them.
 */
export const createKeyedWrites = <Input, Value, E extends BackendError>(
  registry: AtomRegistry.AtomRegistry,
  write: (id: string, input: Input) => Effect.Effect<Value, E, Backend>,
) => {
  const empty: WriteView<Input, Value> = { confirmed: undefined, feedback: null }
  const viewsAtom = Atom.make<ReadonlyMap<string, WriteView<Input, Value>>>(new Map())
  const lockedAtom = Atom.make(false)

  const dispose = registry.mount(
    Atom.make((get) => {
      get(viewsAtom)
      get(lockedAtom)
    }),
  )

  const viewAtom = Atom.family((id: string) => Atom.make((get) => get(viewsAtom).get(id) ?? empty))

  const patch = (id: string, change: Partial<WriteView<Input, Value>>) =>
    registry.update(viewsAtom, (views) =>
      new Map(views).set(id, { ...(views.get(id) ?? empty), ...change }),
    )

  const writeAtom = Atom.family((id: string) =>
    backendRuntime.fn((input: Input, get) => {
      get.mount(viewsAtom)

      return write(id, input).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            patch(
              id,
              Exit.isSuccess(exit)
                ? { confirmed: exit.value, feedback: null }
                : { feedback: { type: "failed", input, problem: problemOf(exit.cause) } },
            ),
          ),
        ),
      )
    }),
  )

  return {
    viewAtom,
    lockedAtom,
    dispose,
    set(id: string, input: Input) {
      if (registry.get(lockedAtom) || registry.get(viewAtom(id)).feedback?.type === "sending")
        return

      patch(id, { feedback: { type: "sending", input } })
      const action = writeAtom(id)
      const release = registry.mount(action)

      registry.set(action, input)
      void Effect.runPromiseExit(
        AtomRegistry.getResult(registry, action, { suspendOnWaiting: true }),
      ).finally(release)
    },
    async lock() {
      registry.set(lockedAtom, true)
      await Effect.runPromise(
        AtomRegistry.toStream(registry, viewsAtom).pipe(
          Stream.filter(
            (views) => ![...views.values()].some((view) => view.feedback?.type === "sending"),
          ),
          Stream.runHead,
        ),
      )
    },
    unlock: () => registry.set(lockedAtom, false),
  }
}
