import { Atom } from "effect/reactivity"

export const localStorageBooleanAtom = (key: string) =>
  Atom.writable(
    () => localStorage.getItem(key) === "true",
    (ctx, value: boolean) => {
      localStorage.setItem(key, String(value))
      ctx.setSelf(value)
    },
  ).pipe(Atom.keepAlive)
