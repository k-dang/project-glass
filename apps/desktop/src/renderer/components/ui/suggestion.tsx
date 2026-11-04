import { cn } from "cn"
import type * as React from "react"

import { Button } from "@/components/ui/button"

function Suggestions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="suggestions"
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
}

function Suggestion({
  className,
  variant = "outline",
  size = "sm",
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="suggestion"
      type="button"
      variant={variant}
      size={size}
      className={cn("rounded-full px-3", className)}
      {...props}
    />
  )
}

export { Suggestion, Suggestions }
