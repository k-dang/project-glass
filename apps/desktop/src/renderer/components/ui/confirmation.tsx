import type * as React from "react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item"

function Confirmation({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <Item
      variant="outline"
      size="sm"
      render={<section {...props} />}
      className={cn(
        "flex-col flex-nowrap items-stretch gap-2 bg-card text-card-foreground",
        className,
      )}
    />
  )
}

function ConfirmationTitle({ className, children, ...props }: React.ComponentProps<"h3">) {
  return (
    <ItemContent className="flex-none">
      <ItemTitle className="w-full line-clamp-none">
        <h3 className={cn("flex items-center gap-2 [&_svg]:size-4", className)} {...props}>
          {children}
        </h3>
      </ItemTitle>
    </ItemContent>
  )
}

function ConfirmationActions({ className, ...props }: React.ComponentProps<"div">) {
  return <ItemActions className={cn("justify-end", className)} {...props} />
}

function ConfirmationAction(props: React.ComponentProps<typeof Button>) {
  return <Button size="sm" type="button" {...props} />
}

export { Confirmation, ConfirmationAction, ConfirmationActions, ConfirmationTitle }
