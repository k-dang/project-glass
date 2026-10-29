import { Button } from "@/components/ui/button"
import { useReviewShortcuts } from "./useReviewShortcuts"

export function BackToPullRequests(props: { onBack: () => void; disabled?: boolean }) {
  useReviewShortcuts([
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
