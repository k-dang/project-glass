import { XIcon } from "lucide-react"
import type { ReactElement, ReactNode, RefObject } from "react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "cn"

export function ActionPopover(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  trigger: ReactElement
  title: string
  initialFocus?: RefObject<HTMLElement | null>
  className?: string
  children: ReactNode
}) {
  return (
    <Popover
      open={props.open}
      onOpenChange={(next, details) => {
        if (
          !next &&
          props.busy &&
          (details.reason === "outside-press" || details.reason === "focus-out")
        ) {
          details.cancel()

          return
        }

        props.onOpenChange(next)
      }}
    >
      <PopoverTrigger render={props.trigger} />
      <PopoverContent
        align="end"
        initialFocus={props.initialFocus}
        className={cn(
          "max-h-(--available-height) max-w-(--available-width) gap-3 overflow-y-auto p-4",
          props.className,
        )}
      >
        <div className="-mt-1 -mr-2 flex shrink-0 items-center justify-between">
          <PopoverTitle className="font-semibold">{props.title}</PopoverTitle>
          <PopoverClose render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
            <XIcon aria-hidden />
          </PopoverClose>
        </div>
        {props.children}
      </PopoverContent>
    </Popover>
  )
}
