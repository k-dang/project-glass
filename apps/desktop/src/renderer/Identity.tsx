import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import type { ComponentProps } from "react"
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar"
import { useConnection } from "./connection"
import { describeSource } from "./problems"

export interface Identity {
  readonly label: string
  readonly initial: string
  readonly dot: string
}

export function useIdentity(): Identity {
  const { result } = useConnection()

  return AsyncResult.builder(result)
    .onInitialOrWaiting(() => ({
      label: "Connecting to GitHub…",
      initial: "…",
      dot: "animate-pulse bg-muted-foreground",
    }))
    .onFailure(() => ({ label: "Not connected to GitHub", initial: "!", dot: "bg-destructive" }))
    .onSuccess((connection) => ({
      label: `@${connection.login} · via ${describeSource(connection.tokenSource)}`,
      initial: connection.login.slice(0, 1).toUpperCase(),
      dot: "bg-emerald-500",
    }))
    .render()
}

export function IdentityAvatar({
  identity,
  className,
  ...props
}: ComponentProps<typeof Avatar> & { identity: Identity }) {
  return (
    <Avatar className={cn("size-7", className)} {...props}>
      <AvatarFallback className="bg-accent text-xs">{identity.initial}</AvatarFallback>
      <AvatarBadge className={`-right-0.5 -bottom-0.5 ${identity.dot}`} aria-hidden />
    </Avatar>
  )
}
