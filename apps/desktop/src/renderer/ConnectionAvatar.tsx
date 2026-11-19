import { AsyncResult } from "effect/reactivity"
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar"
import { TooltipHint } from "@/components/ui/tooltip"
import { useConnection } from "./connection"
import { describeSource } from "./problems"

export function ConnectionAvatar() {
  const { result } = useConnection()

  const identity = AsyncResult.builder(result)
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

  return (
    <TooltipHint content={identity.label} side="right">
      <Avatar render={<output />} aria-label={identity.label} className="size-7">
        <AvatarFallback className="bg-accent text-xs">{identity.initial}</AvatarFallback>
        <AvatarBadge className={`-right-0.5 -bottom-0.5 ${identity.dot}`} aria-hidden />
      </Avatar>
    </TooltipHint>
  )
}
