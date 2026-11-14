import { toast } from "@/components/ui/toast"

export const copyText = async (text: string, copiedTitle: string) => {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ type: "success", title: copiedTitle, timeout: 2500 })
  } catch {
    toast.add({ type: "error", title: "Couldn't copy to the clipboard" })
  }
}
