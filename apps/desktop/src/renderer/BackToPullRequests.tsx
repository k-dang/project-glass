import { Button } from "@/components/ui/button"
import { useShortcuts } from "./useShortcuts"

export function BackToPullRequests(props: { onBack: () => void; disabled?: boolean }) {
  useShortcuts([
    {
      key: "Escape",
      run: () => {
        if (!props.disabled) props.onBack()
      },
    },
  ])

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={props.onBack}
      disabled={props.disabled}
      aria-keyshortcuts="Escape"
      title="Back to PRs (Esc)"
    >
      Back to PRs
    </Button>
  )
}
