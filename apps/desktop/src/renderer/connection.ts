import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/reactivity"
import { Backend, backendRuntime } from "./backend"

export const connectionAtom = backendRuntime
  .atom(Backend.use((backend) => backend.GetConnection()))
  .pipe(Atom.keepAlive)

export const useConnection = () => ({
  result: useAtomValue(connectionAtom),
  retry: useAtomRefresh(connectionAtom),
})
