import type * as React from "react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"

// Adapted from AI Elements' Confirmation, without its AI SDK tool states: the caller shows the
// actions while the request waits and the outcome once it's settled.

function Confirmation({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="confirmation"
      className={cn(
        "flex w-full flex-col gap-2 rounded-lg border bg-card px-3 py-2.5 text-sm text-card-foreground",
        className,
      )}
      {...props}
    />
  )
}

function ConfirmationTitle({ className, children, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="confirmation-title"
      className={cn("flex items-center gap-2 font-medium [&_svg]:size-4", className)}
      {...props}
    >
      {children}
    </h3>
  )
}

function ConfirmationActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="confirmation-actions"
      className={cn("flex items-center justify-end gap-2", className)}
      {...props}
    />
  )
}

function ConfirmationAction(props: React.ComponentProps<typeof Button>) {
  return <Button className="h-8 px-3 text-sm" type="button" {...props} />
}

export { Confirmation, ConfirmationAction, ConfirmationActions, ConfirmationTitle }
