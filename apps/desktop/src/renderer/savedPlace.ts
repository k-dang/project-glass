import { ResumableDestination } from "@glass/contracts"
import { Effect, Schema, Semaphore } from "effect"
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity"
import { toast } from "@/components/ui/toast"
import { Backend, backendRuntime } from "./backend"
import { problemOf, problemText } from "./problems"

export const loadedPlaceAtom = backendRuntime
  .atom(
    Backend.use((backend) => backend.GetSavedPlace()).pipe(
      Effect.map((saved) => saved?.destination ?? null),
    ),
  )
  .pipe(Atom.keepAlive)

const currentDestinationAtom = Atom.make<ResumableDestination | null>(null).pipe(Atom.keepAlive)

const saveLockAtom = Atom.make(() => Semaphore.makeUnsafe(1)).pipe(Atom.keepAlive)

const sameDestination = Schema.toEquivalence(ResumableDestination)

export const savedDestinationAtom = Atom.make((get) => {
  const current = get(currentDestinationAtom)

  return current === null ? get(loadedPlaceAtom) : AsyncResult.success(current)
})

const savePlaceAtom = backendRuntime
  .fn(
    (destination: ResumableDestination, get) =>
      get(saveLockAtom).withPermit(
        Effect.gen(function* () {
          if (get.registry.get(currentDestinationAtom) !== destination) return

          yield* Backend.use((backend) => backend.SavePlace({ destination }))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (get.registry.get(currentDestinationAtom) !== destination) return

              toast.add({
                type: "error",
                title: "Couldn't save your place",
                description: problemText(problemOf(cause)),
                actionProps: {
                  children: "Retry",
                  onClick: () => retrySave(get.registry),
                },
              })
            }),
          ),
        ),
      ),
    { concurrent: true },
  )
  .pipe(Atom.keepAlive)

function retrySave(registry: AtomRegistry.AtomRegistry): void {
  const destination = registry.get(currentDestinationAtom)

  if (destination !== null) registry.set(savePlaceAtom, destination)
}

export const rememberPlace = (
  registry: AtomRegistry.AtomRegistry,
  destination: ResumableDestination,
) => {
  const latest = registry.get(currentDestinationAtom)

  if (latest !== null && sameDestination(latest, destination)) return

  registry.set(currentDestinationAtom, destination)
  registry.set(savePlaceAtom, destination)
}
