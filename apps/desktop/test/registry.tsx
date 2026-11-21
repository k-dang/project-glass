import { RegistryContext, scheduleTask } from "@effect/atom-react"
import { cleanup } from "@testing-library/react"
import { type Atom, AtomRegistry } from "effect/reactivity"
import { type ReactNode, useState } from "react"

const live = new Set<AtomRegistry.AtomRegistry>()

const scheduled = new Map<() => void, () => void>()

const tracked = (task: () => void) => {
  const run = () => {
    scheduled.delete(run)
    task()
  }

  const cancel = scheduleTask(run)

  scheduled.set(run, cancel)

  return () => {
    scheduled.delete(run)
    cancel()
  }
}

export const RegistryProvider = ({
  initialValues,
  children,
}: {
  readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]>
  readonly children: ReactNode
}) => {
  const [registry] = useState(() => {
    const created = AtomRegistry.make({ initialValues, scheduleTask: tracked })

    live.add(created)

    return created
  })

  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
}

export const disposeRegistries = () => {
  cleanup()

  while (scheduled.size > 0)
    for (const [run, cancel] of scheduled) {
      cancel()
      run()
    }

  for (const registry of live) registry.dispose()

  live.clear()
}
