import { AsyncResult } from "effect/reactivity"
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar"
import { TooltipHint } from "@/components/ui/tooltip"
import { AgentSettings } from "./AgentSettings"
import { AppearanceSettings } from "./AppearanceSettings"
import { useConnection } from "./connection"
import { FollowedRepositoriesSettings } from "./FollowedRepositories"
import { ProblemAlert } from "./ProblemAlert"
import { describeSource, problemOf } from "./problems"
import { SettingsSection } from "./SettingsSection"
import { SkillPacksSettings } from "./SkillPacks"
import { StorageSettings } from "./StorageSettings"

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

function ConnectionDetails() {
  const { result, retry } = useConnection()

  return AsyncResult.builder(result)
    .onInitialOrWaiting(() => (
      <p className="text-sm text-muted-foreground">Connecting to GitHub…</p>
    ))
    .onFailure((cause) => (
      <ProblemAlert problem={problemOf(cause)} action={{ label: "Try again", run: retry }} />
    ))
    .onSuccess((connection) => (
      <dl className="divide-y text-sm">
        <div className="flex justify-between gap-6 py-4">
          <dt className="text-muted-foreground">Identity</dt>
          <dd>@{connection.login}</dd>
        </div>
        <div className="flex justify-between gap-6 py-4">
          <dt className="text-muted-foreground">Token source</dt>
          <dd>{describeSource(connection.tokenSource)}</dd>
        </div>
      </dl>
    ))
    .render()
}

export function Settings() {
  return (
    <div className="page-content flex flex-col gap-8 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Changes save automatically. Text fields save when you leave them.
        </p>
      </div>
      <SettingsSection title="GitHub connection" description="The identity Glass uses on GitHub.">
        <ConnectionDetails />
      </SettingsSection>
      <FollowedRepositoriesSettings />
      <AppearanceSettings />
      <AgentSettings />
      <SkillPacksSettings />
      <StorageSettings />
    </div>
  )
}
