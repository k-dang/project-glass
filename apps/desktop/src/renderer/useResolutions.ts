import { useAtomValue } from "@effect/atom-react"
import { Effect, Exit, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { Backend, backendRuntime } from "./backend"
import { type Problem, problemOf } from "./problems"

export type ResolutionFeedback =
  | { readonly type: "sending"; readonly resolved: boolean }
  | { readonly type: "failed"; readonly resolved: boolean; readonly problem: Problem }

export interface ResolutionView {
  readonly confirmed: boolean | undefined
  readonly feedback: ResolutionFeedback | null
}

const empty: ResolutionView = { confirmed: undefined, feedback: null }

export const createResolutions = (registry: AtomRegistry.AtomRegistry) => {
  const viewsAtom = Atom.make<ReadonlyMap<string, ResolutionView>>(new Map())
  const lockedAtom = Atom.make(false)

  const dispose = registry.mount(
    Atom.make((get) => {
      get(viewsAtom)
      get(lockedAtom)
    }),
  )

  const viewAtom = Atom.family((id: string) => Atom.make((get) => get(viewsAtom).get(id) ?? empty))

  const update = (id: string, view: ResolutionView) =>
    registry.update(viewsAtom, (views) => new Map(views).set(id, view))

  const setAtom = Atom.family((discussionId: string) =>
    backendRuntime.fn((resolved: boolean, get) => {
      get.mount(viewsAtom)

      return Backend.use((backend) =>
        backend.SetDiscussionResolved({ discussionId, resolved }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            update(
              discussionId,
              Exit.isSuccess(exit)
                ? { confirmed: exit.value, feedback: null }
                : {
                    confirmed: registry.get(viewAtom(discussionId)).confirmed,
                    feedback: { type: "failed", resolved, problem: problemOf(exit.cause) },
                  },
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
    set(discussionId: string, resolved: boolean) {
      const view = registry.get(viewAtom(discussionId))

      if (registry.get(lockedAtom) || view.feedback?.type === "sending") return

      update(discussionId, { ...view, feedback: { type: "sending", resolved } })
      const action = setAtom(discussionId)
      const release = registry.mount(action)

      registry.set(action, resolved)
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

export type Resolutions = ReturnType<typeof createResolutions>

export const useResolution = (resolutions: Resolutions, discussionId: string) =>
  useAtomValue(resolutions.viewAtom(discussionId))
