import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipHint } from "@/components/ui/tooltip"
import { useActions } from "./actions"

export function BackToPullRequests(props: {
  onBack: () => void
  disabled?: boolean
  iconOnly?: boolean
}) {
  useActions([
    !props.disabled && {
      id: "back-to-pull-requests",
      title: "Back to PRs",
      group: "Pull request",
      icon: ArrowLeft,
      shortcut: { key: "Escape" },
      run: props.onBack,
    },
  ])

  if (props.iconOnly)
    return (
      <TooltipHint content="Back to PRs (Esc)">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to PRs"
          aria-keyshortcuts="Escape"
          onClick={props.onBack}
          disabled={props.disabled}
        >
          <ArrowLeft aria-hidden />
        </Button>
      </TooltipHint>
    )

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
