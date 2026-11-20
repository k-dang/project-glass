import type { LucideIcon } from "lucide-react"
import { useEffect, useLayoutEffect, useRef } from "react"
import { type Shortcut, useShortcuts } from "./useShortcuts"

export const actionGroups = [
  "Pull request",
  "Copy",
  "Conversation",
  "Inbox",
  "Go to",
  "Glass",
] as const

export type ActionGroup = (typeof actionGroups)[number]

export type ActionShortcut = Omit<Shortcut, "run">

export interface Action {
  readonly id: string
  readonly title: string
  readonly detail?: string
  readonly group: ActionGroup
  readonly icon?: LucideIcon
  readonly keywords?: ReadonlyArray<string>
  readonly shortcut?: ActionShortcut
  readonly run: () => void
}

export const shortcutKeys = ({ key, mod, shift }: ActionShortcut) =>
  [mod && "mod", shift === true && "shift", [key].flat()[0]!.toLowerCase()]
    .filter(Boolean)
    .join("+")

type Source = { current: ReadonlyArray<Action> }

const sources = new Set<Source>()

export function useActions(given: ReadonlyArray<Action | false>) {
  const actions = given.filter((action) => action !== false)
  const source = useRef(actions)

  useShortcuts(
    actions.flatMap(({ shortcut, run }) => (shortcut === undefined ? [] : [{ ...shortcut, run }])),
  )

  useLayoutEffect(() => {
    source.current = actions
  })

  useEffect(() => {
    sources.add(source)

    return () => {
      sources.delete(source)
    }
  }, [source])
}

export const mountedActions = (): ReadonlyArray<Action> =>
  [...sources].flatMap((source) => source.current)
