import { useAtomValue } from "@effect/atom-react"
import type { Revision } from "@glass/contracts"
import { Exit } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { Backend, backendRuntimeOf, type BackendRuntime } from "./backend"
import { type Problem, problemOf } from "./problems"

export interface ViewedFilesState {
  readonly viewed: ReadonlySet<string>
  readonly saving: ReadonlySet<string>
  readonly locked: boolean
  readonly failures: ReadonlyMap<
    string,
    {
      readonly viewed: boolean
      readonly problem: Problem
    }
  >
}

interface ViewedFilesSource {
  readonly pullRequest: { readonly id: string }
  readonly revision: Revision
  readonly viewedPaths: ReadonlyArray<string>
}

export class ViewedFilesStore {
  readonly #workspace: ViewedFilesSource
  readonly #runtime: BackendRuntime
  readonly #calls = new Set<Promise<void>>()
  readonly dispose: () => void
  readonly stateAtom: Atom.Writable<ViewedFilesState>

  constructor(
    workspace: ViewedFilesSource,
    readonly registry: AtomRegistry.AtomRegistry,
  ) {
    this.#workspace = workspace
    this.#runtime = backendRuntimeOf(registry)
    this.stateAtom = Atom.make<ViewedFilesState>({
      viewed: new Set(workspace.viewedPaths),
      saving: new Set<string>(),
      locked: false,
      failures: new Map(),
    })
    this.dispose = registry.mount(this.stateAtom)
  }

  readonly snapshot = () => this.registry.get(this.stateAtom)

  set(path: string, viewed: boolean) {
    const before = this.snapshot()

    if (before.locked || (before.viewed.has(path) === viewed && !before.failures.has(path))) return

    const paths = new Set(before.viewed)
    const failures = new Map(before.failures)

    failures.delete(path)

    if (viewed) paths.add(path)
    else paths.delete(path)

    this.registry.set(this.stateAtom, {
      ...before,
      viewed: paths,
      saving: new Set(before.saving).add(path),
      failures,
    })

    if (before.saving.has(path)) return

    const release = this.registry.mount(this.stateAtom)

    const done = this.#save(path, before.viewed.has(path)).finally(() => {
      this.#calls.delete(done)
      release()
    })

    this.#calls.add(done)
  }

  async #save(path: string, confirmed: boolean) {
    while (true) {
      const viewed = this.snapshot().viewed.has(path)

      const exit = await this.#runtime.runPromiseExit(
        Backend.use((backend) =>
          backend.SetFileViewed({
            pullRequestId: this.#workspace.pullRequest.id,
            revision: this.#workspace.revision,
            path,
            viewed,
          }),
        ),
      )

      if (Exit.isSuccess(exit)) confirmed = viewed

      if (this.snapshot().viewed.has(path) !== viewed) continue

      const saving = new Set(this.snapshot().saving)

      saving.delete(path)

      if (Exit.isSuccess(exit)) {
        this.registry.set(this.stateAtom, { ...this.snapshot(), saving })
      } else {
        const restored = new Set(this.snapshot().viewed)

        if (confirmed) restored.add(path)
        else restored.delete(path)

        this.registry.set(this.stateAtom, {
          ...this.snapshot(),
          viewed: restored,
          saving,
          failures: new Map(this.snapshot().failures).set(path, {
            viewed,
            problem: problemOf(exit.cause),
          }),
        })
      }

      return
    }
  }

  readonly retry = (path: string) => {
    const failure = this.snapshot().failures.get(path)

    if (failure !== undefined) this.set(path, failure.viewed)
  }

  async lock() {
    this.registry.set(this.stateAtom, { ...this.snapshot(), locked: true })
    await Promise.all(this.#calls)
  }

  discardUnsaved() {
    this.registry.set(this.stateAtom, { ...this.snapshot(), failures: new Map() })
  }

  unlock() {
    this.registry.set(this.stateAtom, { ...this.snapshot(), locked: false })
  }
}

export const useViewedFiles = (store: ViewedFilesStore) => useAtomValue(store.stateAtom)
