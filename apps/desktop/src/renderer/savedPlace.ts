import { ResumableDestination } from "@glass/contracts"
import { Effect, Schema, Semaphore } from "effect"
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity"
import { toast } from "@/components/ui/toast"
import { Backend, backendRuntime } from "./backend"
import { problemOf, problemText } from "./problems"

export const loadedPlacesAtom = backendRuntime
  .atom(
    Backend.use((backend) => backend.GetSavedPlaces()).pipe(
      Effect.map((places) => places.map(({ destination }) => destination)),
    ),
  )
  .pipe(Atom.keepAlive)

type Area = ResumableDestination["area"]

const currentDestinationsAtom = Atom.make<ReadonlyArray<ResumableDestination>>([]).pipe(
  Atom.keepAlive,
)

const saveLockAtom = Atom.make(() => Semaphore.makeUnsafe(1)).pipe(Atom.keepAlive)

const sameDestination = Schema.toEquivalence(ResumableDestination)

const currentIn = (registry: AtomRegistry.AtomRegistry, area: Area) =>
  registry.get(currentDestinationsAtom).find((destination) => destination.area === area)

export const savedDestinationsAtom = Atom.make((get) => {
  const current = get(currentDestinationsAtom)
  const loaded = get(loadedPlacesAtom)

  if (current.length > 0 && !AsyncResult.isSuccess(loaded)) return AsyncResult.success(current)

  return AsyncResult.map(loaded, (destinations) => [
    ...current,
    ...destinations.filter(({ area }) => current.every((latest) => latest.area !== area)),
  ])
})

const savePlaceAtom = backendRuntime
  .fn(
    (destination: ResumableDestination, get) =>
      get(saveLockAtom).withPermit(
        Effect.gen(function* () {
          if (currentIn(get.registry, destination.area) !== destination) return

          yield* Backend.use((backend) => backend.SavePlace({ destination }))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (currentIn(get.registry, destination.area) !== destination) return

              toast.add({
                type: "error",
                title: "Couldn't save your place",
                description: problemText(problemOf(cause)),
                actionProps: {
                  children: "Retry",
                  onClick: () => retrySave(get.registry, destination.area),
                },
              })
            }),
          ),
        ),
      ),
    { concurrent: true },
  )
  .pipe(Atom.keepAlive)

function retrySave(registry: AtomRegistry.AtomRegistry, area: Area): void {
  const destination = currentIn(registry, area)

  if (destination !== undefined) registry.set(savePlaceAtom, destination)
}

export const rememberPlace = (
  registry: AtomRegistry.AtomRegistry,
  destination: ResumableDestination,
) => {
  const current = registry.get(currentDestinationsAtom)
  const latest = current.find(({ area }) => area === destination.area)

  if (latest !== undefined && sameDestination(latest, destination)) return

  registry.set(currentDestinationsAtom, [
    destination,
    ...current.filter(({ area }) => area !== destination.area),
  ])
  registry.set(savePlaceAtom, destination)
}
