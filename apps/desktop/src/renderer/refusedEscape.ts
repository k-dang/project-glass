import type { Dialog } from "@base-ui/react/dialog"

type OpenChangeDetails = Parameters<NonNullable<Dialog.Root.Props["onOpenChange"]>>[1]

export const refusedEscape = (details: OpenChangeDetails) => {
  const refused =
    details.reason === "escape-key" &&
    (details.event.defaultPrevented || details.event.isComposing || details.event.repeat)

  if (refused) details.cancel()

  return refused
}
