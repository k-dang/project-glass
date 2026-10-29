import type { KeyboardEvent } from "react"

export const submitOnShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
  // Enter can confirm an input method's candidates.
  if (event.nativeEvent.isComposing || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
    return
  }

  event.preventDefault()
  event.currentTarget.form?.requestSubmit()
}
