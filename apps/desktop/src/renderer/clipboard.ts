import { toast } from "@/components/ui/toast"

/** Copies `text`, then says so in a toast titled `copied`, or that copying failed. */
export const copyText = async (text: string, copied: string) => {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ type: "success", title: copied, timeout: 2500 })
  } catch {
    toast.add({ type: "error", title: "Couldn't copy to the clipboard" })
  }
}
