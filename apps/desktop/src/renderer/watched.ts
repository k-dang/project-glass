import { AsyncResult, Atom } from "effect/reactivity"

const POLL_INTERVAL = 30_000

const STALE_AFTER = 30_000

const isStale = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  !AsyncResult.isSuccess(result) || Date.now() - result.timestamp >= STALE_AFTER

export const watched = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
  Atom.transform(
    atom,
    (get, cached) => {
      const refreshWhen = (due: typeof isStale) => () => {
        const current = get.once(cached)

        if (document.visibilityState === "visible" && !current.waiting && due(current)) {
          get.refresh(cached)
        }
      }

      const refreshNow = refreshWhen(() => true)

      const refreshIfStale = refreshWhen(isStale)

      const entry = setTimeout(refreshIfStale)

      const poll = setInterval(refreshNow, POLL_INTERVAL)

      window.addEventListener("focus", refreshNow)

      document.addEventListener("visibilitychange", refreshIfStale)

      get.addFinalizer(() => {
        clearTimeout(entry)
        clearInterval(poll)
        window.removeEventListener("focus", refreshNow)
        document.removeEventListener("visibilitychange", refreshIfStale)
      })

      get.subscribe(cached, (result) => get.setSelf(result))

      return get.once(cached)
    },
    { initialValueTarget: atom },
  )
