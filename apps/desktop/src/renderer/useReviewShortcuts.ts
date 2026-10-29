import { useEffect, useEffectEvent } from "react"

interface ReviewShortcut {
  readonly key: string
  readonly mod?: boolean
  readonly allowShift?: boolean
  readonly allowInEditable?: boolean
  readonly allowInDialog?: boolean
  readonly run: () => void
}

export function useReviewShortcuts(shortcuts: ReadonlyArray<ReviewShortcut>) {
  const handle = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return
    const elements = event.composedPath().filter((target) => target instanceof Element)

    const editable = elements.some((target) =>
      target.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])"),
    )

    const dialog = elements.some((target) =>
      target.matches('dialog, [role="dialog"], [role="alertdialog"]'),
    )

    for (const shortcut of shortcuts) {
      if (
        event.key.toLowerCase() !== shortcut.key.toLowerCase() ||
        (event.metaKey || event.ctrlKey) !== (shortcut.mod ?? false) ||
        event.altKey ||
        (event.shiftKey && !shortcut.allowShift) ||
        (editable && !shortcut.allowInEditable) ||
        (dialog && !shortcut.allowInDialog)
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
