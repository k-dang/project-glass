import {
  parsePullRequestReference,
  VISUALIZATION_THEME_PARAM,
  VISUALIZATION_THEME_VARIABLES,
  VisualizationMessage,
} from "@glass/contracts"
import { VISUALIZATION_SCHEME } from "@glass/contracts/desktop"
import { Match, Option, Schema } from "effect"
import { Maximize2 } from "lucide-react"
import { memo, use, useEffectEvent, useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { BrowserLinks } from "./BrowserPane"
import { useOpenPullRequest } from "./ThreadPullRequest"

const MIN_HEIGHT = 80

const MAX_HEIGHT = 20_000

const themeSnapshot = () => {
  const style = getComputedStyle(document.documentElement)

  return JSON.stringify(
    Object.fromEntries(
      VISUALIZATION_THEME_VARIABLES.flatMap((name) => {
        const value = style.getPropertyValue(name).trim()

        return value === "" ? [] : [[name, value]]
      }),
    ),
  )
}

const decodeMessage = Schema.decodeUnknownOption(VisualizationMessage)

const fitted = (height: number) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)))

const useOpenLink = () => {
  const browserLinks = use(BrowserLinks)
  const openPullRequest = useOpenPullRequest()

  return (url: string) => {
    if (browserLinks?.policy.opensLink(url) === true) return browserLinks.open(url)

    const pullRequest = parsePullRequestReference(url)

    if (pullRequest !== null) return openPullRequest(pullRequest)

    window.open(url, "_blank", "noopener")
  }
}

interface VisualizationProps {
  readonly id: string
  readonly title: string
}

function VisualizationFrame(props: VisualizationProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const openLink = useEffectEvent(useOpenLink())

  const [src] = useState(
    () =>
      `${VISUALIZATION_SCHEME}://${props.id}/#${VISUALIZATION_THEME_PARAM}=${encodeURIComponent(themeSnapshot())}`,
  )

  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const shown = frame.current

      if (shown === null || event.source !== shown.contentWindow) return

      const message = decodeMessage(event.data)

      if (Option.isNone(message)) return

      Match.valueTags(message.value, {
        VisualizationSized: (sized) => setHeight(fitted(sized.height)),
        VisualizationLinkOpened: ({ url }) => {
          if (document.activeElement === shown && navigator.userActivation.isActive) openLink(url)
        },
      })
    }

    window.addEventListener("message", onMessage)

    return () => window.removeEventListener("message", onMessage)
  }, [])

  return (
    <iframe
      ref={frame}
      src={src}
      title={props.title}
      sandbox="allow-scripts"
      className="block w-full border-0"
      style={{ height }}
    />
  )
}

export const Visualization = memo(function Visualization(props: VisualizationProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="group/visualization relative">
      <VisualizationFrame id={props.id} title={props.title} />
      <Button
        aria-label={`Expand ${props.title}`}
        size="icon-sm"
        variant="outline"
        className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/visualization:opacity-100 focus-visible:opacity-100"
        onClick={() => setExpanded(true)}
      >
        <Maximize2 />
      </Button>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex max-h-[calc(100vh-4rem)] flex-col gap-3 sm:max-w-5xl">
          <DialogTitle>{props.title}</DialogTitle>
          <div className="min-h-0 overflow-y-auto">
            <VisualizationFrame id={props.id} title={props.title} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
})
