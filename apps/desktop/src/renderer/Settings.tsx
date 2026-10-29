import type { Theme } from "@glass/contracts"
import { AsyncResult } from "effect/reactivity"
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar"
import { TooltipHint } from "@/components/ui/tooltip"
import { AgentSettings } from "./AgentSettings"
import { useConnection } from "./connection"
import { FollowedRepositoriesSettings } from "./FollowedRepositories"
import { ProblemAlert } from "./ProblemAlert"
import { describeSource, problemOf } from "./problems"
import { SettingsSection } from "./SettingsSection"
import { useTheme } from "./theme"

const themes = [
  { value: "system", label: "System", description: "Follow your device." },
  { value: "light", label: "Light", description: "Bright and familiar." },
  { value: "dark", label: "Dark", description: "The existing dark theme." },
  { value: "charcoal", label: "Charcoal", description: "Softer surfaces. Colorful code." },
] satisfies ReadonlyArray<{ value: Theme; label: string; description: string }>

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
  const { theme, setTheme } = useTheme()

  return (
    <div className="page-content flex flex-col gap-8 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <FollowedRepositoriesSettings />
      <SettingsSection
        title="Appearance"
        description="Choose how Glass looks, including code and diffs."
      >
        <fieldset className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <legend className="mb-3 text-sm font-medium">Theme</legend>
          {themes.map(({ value, label, description }) => (
            <label
              key={value}
              className="flex cursor-pointer flex-col gap-3 rounded-lg border bg-card p-3 has-checked:border-ring has-checked:ring-1 has-checked:ring-ring has-focus-visible:outline-2 has-focus-visible:outline-offset-4 has-focus-visible:outline-ring"
            >
              <span className="theme-preview" data-preview={value} aria-hidden>
                <span className="theme-preview-rail" />
                <span className="theme-preview-files">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="theme-preview-code">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={theme === value}
                  onChange={() => setTheme(value)}
                  aria-label={label}
                  aria-describedby={`theme-${value}-description`}
                  className="size-3.5 accent-(--ring)"
                />
                {label}
              </span>
              <span id={`theme-${value}-description`} className="text-xs text-muted-foreground">
                {description}
              </span>
            </label>
          ))}
        </fieldset>
      </SettingsSection>
      <AgentSettings />
      <SettingsSection title="GitHub connection" description="The identity Glass uses on GitHub.">
        <ConnectionDetails />
      </SettingsSection>
    </div>
  )
}
