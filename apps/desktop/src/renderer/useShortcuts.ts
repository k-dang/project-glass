import { useEffect, useEffectEvent } from "react"

export interface Shortcut {
  readonly key: string | ReadonlyArray<string>
  readonly mod?: boolean
  readonly shift?: true | "any"
  readonly allowInEditable?: boolean
  readonly allowInDialog?: boolean
  readonly beforeWidgets?: boolean
  readonly run: () => void
}

export function useShortcuts(shortcuts: ReadonlyArray<Shortcut>) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    const beforeWidgets = event.eventPhase === Event.CAPTURING_PHASE

    if (event.defaultPrevented || event.isComposing) return
    const elements = event.composedPath().filter((target) => target instanceof Element)

    const editable = elements.some((target) =>
      target.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])"),
    )

    const dialog = elements.some((target) =>
      target.matches('dialog, [role="dialog"], [role="alertdialog"]'),
    )

    for (const shortcut of shortcuts) {
      if (
        (shortcut.beforeWidgets ?? false) !== beforeWidgets ||
        ![shortcut.key].flat().some((key) => key.toLowerCase() === event.key.toLowerCase()) ||
        (event.metaKey || event.ctrlKey) !== (shortcut.mod ?? false) ||
        event.altKey ||
        (shortcut.shift === true ? !event.shiftKey : event.shiftKey && shortcut.shift !== "any") ||
        (editable && !shortcut.allowInEditable) ||
        (dialog && !shortcut.allowInDialog) ||
        event.repeat
      )
        continue

      event.preventDefault()
      shortcut.run()

      return
    }
  })

  useEffect(() => {
    window.addEventListener("keydown", handle, { capture: true })
    window.addEventListener("keydown", handle)

    return () => {
      window.removeEventListener("keydown", handle, { capture: true })
      window.removeEventListener("keydown", handle)
    }
  }, [])
}
