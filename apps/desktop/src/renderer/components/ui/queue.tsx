import * as React from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"

function QueueList({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="queue-list"
      className={cn("flex max-h-40 flex-col overflow-y-auto rounded-lg border py-1", className)}
      {...props}
    />
  )
}

function QueueItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="queue-item"
      className={cn(
        "group flex flex-col gap-1 px-3 py-1 text-sm transition-colors hover:bg-muted",
        className,
      )}
      {...props}
    />
  )
}

function QueueItemRow({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-2", className)} {...props} />
}

function QueueItemContent({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="queue-item-content"
      className={cn("line-clamp-1 grow break-words text-muted-foreground", className)}
      {...props}
    />
  )
}

function QueueItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 gap-1", className)} {...props} />
}

function QueueItemAction({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn(
        "size-auto rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted-foreground/10 hover:text-foreground focus-visible:opacity-100",
        className,
      )}
      {...props}
    />
  )
}

function QueueItemAttachment({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap gap-2", className)} {...props} />
}

export {
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemAttachment,
  QueueItemContent,
  QueueItemRow,
  QueueList,
}
