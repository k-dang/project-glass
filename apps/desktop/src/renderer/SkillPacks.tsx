import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  isSkillPackName,
  shortCommit,
  type Skill,
  type SkillPack,
  type SkillPackPreview,
  type SkillPackSource,
  type SkillPackUpdate,
  type SkippedSkill,
  skillPackUrl,
} from "@glass/contracts"
import { Effect, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Backend, type BackendError, backendRuntime } from "./backend"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, settledProblem } from "./problems"
import { SettingsSection } from "./SettingsSection"

interface PackChange {
  readonly target: string
  readonly save: Effect.Effect<ReadonlyArray<SkillPack>, BackendError, Backend>
}

const savedSkillPacksAtom = backendRuntime
  .atom(Backend.use((backend) => backend.ListSkillPacks()))
  .pipe(Atom.keepAlive)

const changeAtom = backendRuntime.fn((change: PackChange) => change.save).pipe(Atom.keepAlive)

export const skillPacksAtom = Atom.make((get) =>
  Option.match(AsyncResult.value(get(changeAtom)), {
    onSome: (saved) => AsyncResult.success(saved),
    onNone: () => get(savedSkillPacksAtom),
  }),
)

const previewAtom = backendRuntime.fn((url: string) =>
  Backend.use((backend) => backend.PreviewSkillPack({ url })),
)

const updatePreviewAtom = backendRuntime.fn((name: string) =>
  Backend.use((backend) => backend.PreviewSkillPackUpdate({ name })),
)

const sourceLabel = (source: SkillPackSource) =>
  [`${source.owner}/${source.repo}`, source.path].filter((part) => part !== "").join("/")

function SkillList(props: { label: string; skills: ReadonlyArray<Skill> }) {
  if (props.skills.length === 0) return null

  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted-foreground">{props.label}</h4>
      <ul aria-label={props.label} className="flex flex-col gap-1 text-sm">
        {props.skills.map((skill) => (
          <li key={skill.name}>
            <span className="font-medium">{skill.name}</span>
            <span className="text-muted-foreground"> · {skill.description}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SkippedList(props: { skipped: ReadonlyArray<SkippedSkill> }) {
  if (props.skipped.length === 0) return null

  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-medium text-muted-foreground">Skipped</h4>
      <ul aria-label="Skipped skills" className="flex flex-col gap-1 text-sm">
        {props.skipped.map(({ directory, reason }) => (
          <li key={directory}>
            <span className="font-medium">{directory === "" ? "This folder" : directory}</span>
            <span className="text-muted-foreground"> · {reason}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function useChange() {
  const change = useAtomValue(changeAtom)
  const [target, setTarget] = useState<string | null>(null)
  const save = useAtomSet(changeAtom)

  return {
    pending: change.waiting ? target : null,
    problem: settledProblem(change),
    run: (next: PackChange) => {
      if (change.waiting) return

      setTarget(next.target)
      save(next)
    },
  }
}

type Change = ReturnType<typeof useChange>

export function SkillPacksSettings() {
  const packs = useAtomValue(skillPacksAtom)
  const retry = useAtomRefresh(savedSkillPacksAtom)
  const change = useChange()

  return (
    <SettingsSection
      title="Skill packs"
      description="Skills from a GitHub folder that you can give Agents. A pack stays on the commit you added it at until you update it."
    >
      {AsyncResult.builder(packs)
        .onInitialOrWaiting(() => <output>Loading Skill packs…</output>)
        .onFailure((cause) => (
          <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: retry }} />
        ))
        .onSuccess((value) => (
          <>
            <AddSkillPack packs={value} change={change} />
            <PackList packs={value} change={change} />
            {change.problem !== null && <ProblemAlert problem={change.problem} />}
          </>
        ))
        .render()}
    </SettingsSection>
  )
}

function AddSkillPack(props: { packs: ReadonlyArray<SkillPack>; change: Change }) {
  const [url, setUrl] = useState("")
  const [preview, setPreview] = useAtom(previewAtom)

  const close = () => {
    setUrl("")
    setPreview(Atom.Reset)
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setPreview(url.trim())
        }}
      >
        <fieldset disabled={preview.waiting} className="flex flex-col gap-2">
          <Label htmlFor="skill-pack-url">GitHub URL</Label>
          <div className="flex items-center gap-2">
            <Input
              id="skill-pack-url"
              aria-describedby="skill-pack-url-hint"
              placeholder="https://github.com/owner/repo/tree/main/skills"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              spellCheck={false}
            />
            <Button type="submit" disabled={preview.waiting || url.trim() === ""}>
              {preview.waiting ? "Reading…" : "Preview"}
            </Button>
          </div>
          <p id="skill-pack-url-hint" className="text-xs text-muted-foreground">
            A folder or repository on GitHub. Glass reads it with your GitHub connection.
          </p>
        </fieldset>
      </form>
      {AsyncResult.builder(preview)
        .onFailure((cause) => <ProblemAlert problem={problemOf(cause)} />)
        .onSuccess((value) => (
          <PreviewCard
            key={`${value.commit}:${sourceLabel(value.source)}`}
            preview={value}
            packs={props.packs}
            change={props.change}
            onDone={close}
          />
        ))
        .orNull()}
    </div>
  )
}

function PreviewCard(props: {
  preview: SkillPackPreview
  packs: ReadonlyArray<SkillPack>
  change: Change
  onDone: () => void
}) {
  const { preview, change } = props
  const [name, setName] = useState(preview.suggestedName)
  const taken = props.packs.some((pack) => pack.name === name)
  const valid = isSkillPackName(name)
  const adding = change.pending === "add"

  const hint = taken
    ? `You already have a pack named ${name}.`
    : valid
      ? `Agents run its skills as /${name}:skill. The name can't change later.`
      : "Use lowercase letters, digits, and single hyphens."

  return (
    <form
      aria-label="Skill pack preview"
      className="flex flex-col gap-4 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault()

        change.run({
          target: "add",
          save: Backend.use((backend) =>
            backend.AddSkillPack({ source: preview.source, commit: preview.commit, name }),
          ).pipe(Effect.tap(() => Effect.sync(props.onDone))),
        })
      }}
    >
      <p className="text-sm">
        <span className="font-medium">{sourceLabel(preview.source)}</span>
        <span className="text-muted-foreground"> @ {shortCommit(preview.commit)}</span>
      </p>
      <SkillList label="Skills" skills={preview.skills} />
      <SkippedList skipped={preview.skipped} />
      <fieldset disabled={adding} className="flex flex-col gap-2">
        <Label htmlFor="skill-pack-name">Name</Label>
        <Input
          id="skill-pack-name"
          aria-describedby="skill-pack-name-hint"
          aria-invalid={taken || !valid}
          value={name}
          onChange={(event) => setName(event.target.value)}
          spellCheck={false}
        />
        <p id="skill-pack-name-hint" className="text-xs text-muted-foreground">
          {hint}
        </p>
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" disabled={adding || taken || !valid || preview.skills.length === 0}>
          {adding ? "Adding…" : "Add pack"}
        </Button>
        <Button type="button" variant="outline" disabled={adding} onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function PackList(props: { packs: ReadonlyArray<SkillPack>; change: Change }) {
  const [removing, setRemoving] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)
  const [update, previewUpdate] = useAtom(updatePreviewAtom)

  if (props.packs.length === 0) {
    return <p className="text-sm text-muted-foreground">No Skill packs yet.</p>
  }

  return (
    <>
      <ul aria-label="Skill packs" className="divide-y rounded-md border px-3">
        {props.packs.map((pack) => (
          <li key={pack.name} className="flex flex-col gap-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-sm">
                <p className="font-medium">{pack.name}</p>
                <p className="break-all text-muted-foreground">
                  {skillPackUrl(pack.source)} @ {shortCommit(pack.commit)}
                </p>
                <p className="text-muted-foreground">
                  {pack.skills.map((skill) => skill.name).join(", ")}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {pack.updatable && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Update ${pack.name}`}
                    disabled={props.change.pending !== null || update.waiting}
                    onClick={() => {
                      setUpdating(pack.name)
                      previewUpdate(pack.name)
                    }}
                  >
                    {update.waiting && updating === pack.name ? "Checking…" : "Update"}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Remove ${pack.name}`}
                  disabled={props.change.pending !== null}
                  onClick={() => setRemoving(pack.name)}
                >
                  {props.change.pending === `remove:${pack.name}` ? "Removing…" : "Remove"}
                </Button>
              </div>
            </div>
            {updating === pack.name &&
              AsyncResult.builder(update)
                .onFailure((cause) => <ProblemAlert problem={problemOf(cause)} />)
                .onSuccess((value) => (
                  <UpdateCard
                    update={value}
                    change={props.change}
                    onDone={() => {
                      setUpdating(null)
                      previewUpdate(Atom.Reset)
                    }}
                  />
                ))
                .orNull()}
          </li>
        ))}
      </ul>
      <ConfirmationDialog
        open={removing !== null}
        title={`Remove ${removing}?`}
        description="New Agents can't get its skills. You can add it again from its URL."
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const name = removing!

          setRemoving(null)
          props.change.run({
            target: `remove:${name}`,
            save: Backend.use((backend) => backend.RemoveSkillPack({ name })),
          })
        }}
      />
    </>
  )
}

function UpdateCard(props: { update: SkillPackUpdate; change: Change; onDone: () => void }) {
  const { update, change } = props
  const saving = change.pending === `update:${update.name}`

  if (update.from === update.to) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
        <p>Already up to date at {shortCommit(update.to)}.</p>
        <Button variant="outline" size="sm" onClick={props.onDone}>
          Close
        </Button>
      </div>
    )
  }

  const unchanged =
    update.added.length === 0 && update.removed.length === 0 && update.changed.length === 0

  return (
    <div aria-label={`Update ${update.name}`} className="flex flex-col gap-3 rounded-md border p-3">
      <p className="text-sm">
        {shortCommit(update.from)} → {shortCommit(update.to)}
        {unchanged && <span className="text-muted-foreground"> · No skills changed.</span>}
      </p>
      <SkillList label="Added" skills={update.added} />
      <SkillList label="Changed" skills={update.changed} />
      <SkillList label="Removed" skills={update.removed} />
      <SkippedList skipped={update.skipped} />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={change.pending !== null}
          onClick={() => {
            change.run({
              target: `update:${update.name}`,
              save: Backend.use((backend) =>
                backend.UpdateSkillPack({ name: update.name, commit: update.to }),
              ).pipe(Effect.tap(() => Effect.sync(props.onDone))),
            })
          }}
        >
          {saving ? "Updating…" : `Update to ${shortCommit(update.to)}`}
        </Button>
        <Button variant="outline" size="sm" disabled={saving} onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
