import { Atom } from "effect/reactivity"

export const reviewingRevisionAtom = Atom.make(0).pipe(Atom.keepAlive)
