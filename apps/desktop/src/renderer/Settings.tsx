import { AsyncResult } from "effect/reactivity"
import { AgentSettings } from "./AgentSettings"
import { AppearanceSettings } from "./AppearanceSettings"
import { useConnection } from "./connection"
import { FollowedRepositoriesSettings } from "./FollowedRepositories"
import { ProblemAlert } from "./ProblemAlert"
import { describeSource, problemOf } from "./problems"
import { SettingsSection } from "./SettingsSection"
import { OutsideAgentsSettings } from "./OutsideAgentsSettings"
import { SkillPacksSettings } from "./SkillPacks"
import { StorageSettings } from "./StorageSettings"

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
      <OutsideAgentsSettings />
      <AppearanceSettings />
      <AgentSettings />
      <SkillPacksSettings />
      <StorageSettings />
    </div>
  )
}
