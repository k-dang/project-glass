import { useCanGoBack, useRouter, useRouterState } from "@tanstack/react-router"
import { ArrowLeft, ArrowRight } from "lucide-react"
import { useEffect, useEffectEvent } from "react"
import { Button } from "@/components/ui/button"
import { TooltipHint } from "@/components/ui/tooltip"
import { shortcutLabel } from "./shortcutLabel"
import { useShortcuts } from "./useShortcuts"

const BACK_BUTTON = 3

const FORWARD_BUTTON = 4

export function HistoryNav() {
  const { history } = useRouter()
  const canGoBack = useCanGoBack()
  const index = useRouterState({ select: (state) => state.location.state.__TSR_index })
  const canGoForward = index < history.length - 1

  const back = () => {
    if (canGoBack) history.back()
  }

  const forward = () => {
    if (canGoForward) history.forward()
  }

  useShortcuts([
    { key: "ArrowLeft", mod: true, run: back },
    { key: "ArrowRight", mod: true, run: forward },
  ])

  const onMouseUp = useEffectEvent((event: MouseEvent) => {
    if (event.button === BACK_BUTTON) back()
    else if (event.button === FORWARD_BUTTON) forward()
  })

  useEffect(() => {
    window.addEventListener("mouseup", onMouseUp)

    return () => window.removeEventListener("mouseup", onMouseUp)
  }, [])

  return (
    <nav aria-label="History" className="flex items-center gap-0.5 [app-region:no-drag]">
      <TooltipHint content={`Back (${shortcutLabel("←")})`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          aria-keyshortcuts="Meta+ArrowLeft Control+ArrowLeft"
          disabled={!canGoBack}
          onClick={back}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
        </Button>
      </TooltipHint>
      <TooltipHint content={`Forward (${shortcutLabel("→")})`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          aria-keyshortcuts="Meta+ArrowRight Control+ArrowRight"
          disabled={!canGoForward}
          onClick={forward}
        >
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
      </TooltipHint>
    </nav>
  )
}
