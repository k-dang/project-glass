import { useEffect, useEffectEvent } from "react"

interface Shortcut {
  readonly key: string
  readonly mod?: boolean
  readonly allowShift?: boolean
  readonly allowInEditable?: boolean
  readonly allowInDialog?: boolean
  readonly skipOnControl?: boolean
  readonly run: () => void
}

export function useShortcuts(shortcuts: ReadonlyArray<Shortcut>) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return
    const elements = event.composedPath().filter((target) => target instanceof Element)

    const editable = elements.some((target) =>
      target.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])"),
    )

    const dialog = elements.some((target) =>
      target.matches('dialog, [role="dialog"], [role="alertdialog"]'),
    )

    const control = "a, button, [role='link'], [role='button']"

    const onControl =
      elements.some((target) => target.matches(control)) ||
      (event.target instanceof Element && event.target.closest(control) !== null)

    for (const shortcut of shortcuts) {
      if (
        event.key.toLowerCase() !== shortcut.key.toLowerCase() ||
        (event.metaKey || event.ctrlKey) !== (shortcut.mod ?? false) ||
        event.altKey ||
        (event.shiftKey && !shortcut.allowShift) ||
        (editable && !shortcut.allowInEditable) ||
        (dialog && !shortcut.allowInDialog) ||
        (onControl && shortcut.skipOnControl)
      )
        continue

      event.preventDefault()
      shortcut.run()

      return
    }
  })

  useEffect(() => {
    window.addEventListener("keydown", handle)

    return () => window.removeEventListener("keydown", handle)
  }, [])
}
