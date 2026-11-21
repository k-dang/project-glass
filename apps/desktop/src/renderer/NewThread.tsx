import { cn } from "cn"
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  type Thread,
  AgentHarness,
  type ThreadPlace,
  asksPermission,
  defaultPermissionMode,
  type FollowedRepository,
  type LocalCheckout,
  type MessageInput,
  nothingUnsent,
  type ModelChoice,
  type PermissionMode,
  repositoryKey,
  SandboxPlace,
  type SandboxProviderInfo,
  localPlace,
} from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { Exit, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { FolderGit2, FolderPlus, GitBranch, LoaderCircle } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { flushSync } from "react-dom"
import { MessageGroup } from "@/components/ui/message"
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import {
  threadsAtom,
  agentModelsAtom,
  newThreadWrittenAtom,
  createThreadAtom,
  linkCheckoutAtom,
  localCheckoutsAtom,
  newThreadBranchesAtom,
  newThreadCommandsAtom,
  newThreadDefaultBranchAtom,
  newThreadFilesAtom,
  noCommands,
  noFiles,
  placeNames,
  sandboxProvidersAtom,
  placeIcons,
  placeKey,
  placeOfKey,
} from "./threadsArea"
import { threadColumn } from "./threadColumn"
import { ThreadFrame } from "./ThreadFrame"
import { UserMessage } from "./ThreadView"
import type { BackendError } from "./backend"
import { ChipSelect } from "./chips"
import { repositoriesAtom } from "./FollowedRepositories"
import { MessageBox } from "./MessageBox"
import { ModelPicker } from "./ModelPicker"
import { PermissionModePicker } from "./PermissionModePicker"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, settledProblem } from "./problems"
import { useSkillChoice } from "./skillChoice"
import { LocalSkillsToggle, SharedSkillNames, SkillPackPicker } from "./SkillPackPicker"

type HarnessChoice = {
  readonly harness: AgentHarness
  readonly permissionMode: PermissionMode | null
} & ModelChoice

interface Choosable {
  readonly repository: FollowedRepository
  readonly title?: string | undefined
}

interface PlaceOptions {
  readonly place: ThreadPlace
  readonly describe: (key: string | undefined) => string
  readonly starting: (key: string, baseBranch: string) => string
  readonly choosesFolder: boolean
  readonly harnesses: readonly [AgentHarness, ...Array<AgentHarness>]
}

const localOptions: PlaceOptions = {
  place: localPlace,
  describe: (key) =>
    key === undefined
      ? "Choose a folder you cloned a GitHub repository into."
      : "The agent works on a branch of its own.",
  starting: (key, baseBranch) => `Making the Thread's copy of ${key} from ${baseBranch}…`,
  choosesFolder: true,
  harnesses: AgentHarness.literals,
}

const inSandboxOf = ({ id, name, harnesses }: SandboxProviderInfo): PlaceOptions => ({
  place: SandboxPlace.make({ providerId: id }),
  describe: (key) =>
    key === undefined
      ? "Follow a repository in Settings to get started."
      : "The agent works on a branch of its own.",
  starting: () => `Starting the Thread in a Sandbox from ${name}…`,
  choosesFolder: false,
  harnesses,
})

export const defaultPlace = (
  newest: Thread | undefined,
  providers: ReadonlyArray<SandboxProviderInfo>,
  hasCheckouts: boolean,
): ThreadPlace => {
  const available = (place: ThreadPlace) =>
    Predicate.isTagged(place, "sandbox")
      ? providers.some(({ id }) => id === place.providerId)
      : hasCheckouts

  if (newest !== undefined && available(newest.place)) return newest.place

  const first = providers[0]

  return hasCheckouts || first === undefined
    ? localPlace
    : SandboxPlace.make({ providerId: first.id })
}

const unlisted = Atom.make(noCommands)

const unlistedFiles = Atom.make(noFiles)

const noDefaultBranch: Atom.Atom<AsyncResult.AsyncResult<string | null, BackendError>> = Atom.make(
  AsyncResult.success(null),
)

const unlistedBranches: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<string>, BackendError>> =
  Atom.make(AsyncResult.initial())

export function NewThread(props: { repository: string | undefined }) {
  const checkouts = useAtomValue(localCheckoutsAtom)

  const providers = Option.getOrElse(
    AsyncResult.value(useAtomValue(sandboxProvidersAtom)),
    (): ReadonlyArray<SandboxProviderInfo> => [],
  )

  const threads = Option.getOrElse(AsyncResult.value(useAtomValue(threadsAtom)), () => [])

  return AsyncResult.builder(checkouts)
    .onInitial(() => null)
    .onFailure((cause) => (
      <div className="p-6">
        <ProblemAlert problem={problemOf(cause)} />
      </div>
    ))
    .onSuccess((linked) => (
      <ChoosePlace
        checkouts={linked}
        providers={providers}
        repository={props.repository}
        newest={threads.findLast((thread) => !thread.forReview)}
      />
    ))
    .render()
}

const useChooseFolder = () => {
  const navigate = useNavigate()
  const linked = useAtomValue(linkCheckoutAtom)
  const link = useAtomSet(linkCheckoutAtom, { mode: "promiseExit" })

  const choose = async () => {
    const path = await window.glass.chooseFolder()

    if (path === null) return

    const exit = await link(path)

    if (Exit.isSuccess(exit))
      void navigate({
        to: "/threads/new",
        search: { repository: repositoryKey(exit.value.repository) },
      })
  }

  return { choose, waiting: linked.waiting, problem: settledProblem(linked) }
}

interface DraftChoices {
  readonly providers: ReadonlyArray<SandboxProviderInfo>
  readonly where: PlaceOptions
  readonly onPlaceChange: (place: ThreadPlace) => void
  readonly choice: HarnessChoice
  readonly setChoice: (choice: HarnessChoice) => void
  readonly repository: string | undefined
  readonly newest: Thread | undefined
  readonly bases: Readonly<Record<string, string>>
  readonly setBase: (context: string, branch: string) => void
}

function ChoosePlace(props: {
  checkouts: ReadonlyArray<LocalCheckout>
  providers: ReadonlyArray<SandboxProviderInfo>
  repository: string | undefined
  newest: Thread | undefined
}) {
  const { newest, providers } = props
  const [chosenPlace, setChosenPlace] = useState<ThreadPlace | null>(null)
  const [harnesses, setHarnesses] = useState<Readonly<Record<string, AgentHarness>>>({})
  const [harnessChoices, setHarnessChoices] = useState<Readonly<Record<string, HarnessChoice>>>({})
  const [bases, setBases] = useState<Readonly<Record<string, string>>>({})
  const place = chosenPlace ?? defaultPlace(newest, providers, props.checkouts.length > 0)

  const provider = Predicate.isTagged(place, "sandbox")
    ? providers.find(({ id }) => id === place.providerId)
    : undefined

  const where = provider === undefined ? localOptions : inSandboxOf(provider)

  const placeContext = placeKey(where.place)
  const preferredHarness = harnesses[placeContext] ?? newest?.harness ?? "claude-code"
  const harness = where.harnesses.includes(preferredHarness) ? preferredHarness : where.harnesses[0]
  const harnessContext = JSON.stringify([placeContext, harness])
  const inherits = newest?.harness === harness && placeKey(newest.place) === placeContext

  const choice: HarnessChoice = harnessChoices[harnessContext] ?? {
    harness,
    model: inherits ? newest.model : null,
    effort: inherits ? newest.effort : null,
    permissionMode: null,
  }

  const choices: DraftChoices = {
    providers,
    where,
    onPlaceChange: setChosenPlace,
    choice,
    setChoice: (chosen) => {
      setHarnesses((current) => ({ ...current, [placeContext]: chosen.harness }))

      if (chosen.harness === harness)
        setHarnessChoices((current) => ({ ...current, [harnessContext]: chosen }))
    },
    bases,
    setBase: (context, branch) => setBases((current) => ({ ...current, [context]: branch })),
    repository: props.repository,
    newest,
  }

  return provider === undefined ? (
    <>
      {props.checkouts.map((linked) => (
        <PrefetchBranches key={repositoryKey(linked.repository)} checkout={linked} />
      ))}
      <Draft
        {...choices}
        repositories={props.checkouts.map(({ repository, path }) => ({
          repository,
          title: path,
        }))}
      />
    </>
  ) : (
    <InSandbox {...choices} />
  )
}

function InSandbox(props: DraftChoices) {
  const followed = useAtomValue(repositoriesAtom)

  return AsyncResult.builder(followed)
    .onInitial(() => null)
    .onFailure((cause) => (
      <div className="p-6">
        <ProblemAlert problem={problemOf(cause)} />
      </div>
    ))
    .onSuccess((repositories) => (
      <Draft {...props} repositories={repositories.map((repository) => ({ repository }))} />
    ))
    .render()
}

function Draft(props: DraftChoices & { repositories: ReadonlyArray<Choosable> }) {
  const { where, setChoice, newest } = props
  const navigate = useNavigate()
  const folder = useChooseFolder()
  const PlaceIcon = placeIcons[where.place._tag]
  const [written, setWritten] = useAtom(newThreadWrittenAtom)
  const composed = written ?? nothingUnsent

  const find = (key: string | undefined) =>
    props.repositories.find(({ repository }) => repositoryKey(repository) === key)?.repository

  const repository =
    find(props.repository) ??
    find(newest === undefined ? undefined : repositoryKey(newest.repository)) ??
    props.repositories[0]?.repository

  const key = repository === undefined ? undefined : repositoryKey(repository)
  const branchContext = JSON.stringify([placeKey(where.place), key])
  const [browsed, setBrowsed] = useState<string | null>(null)

  const defaults = useAtomValue(
    repository === undefined
      ? noDefaultBranch
      : newThreadDefaultBranchAtom(placeKey(where.place), repository),
  )

  const chosenBase = props.bases[branchContext]
  const readsBranchList = chosenBase !== undefined || browsed === branchContext

  const branches = useAtomValue(
    repository === undefined || !readsBranchList
      ? unlistedBranches
      : newThreadBranchesAtom(placeKey(where.place), repository),
  )

  const skills = useSkillChoice(where.place, props.choice.harness)
  const created = useAtomValue(createThreadAtom)
  const create = useAtomSet(createThreadAtom, { mode: "promiseExit" })
  const defaultBranch = AsyncResult.value(defaults)
  const listed = Option.getOrNull(AsyncResult.value(branches))

  const baseBranch = pickBase(chosenBase, listed, Option.getOrNull(defaultBranch))

  const offered = useAtomValue(agentModelsAtom(props.choice.harness, placeKey(where.place)))

  const commands = useAtomValue(
    repository === undefined
      ? unlisted
      : newThreadCommandsAtom(props.choice.harness, placeKey(where.place), repository),
  )

  const files = useAtomValue(
    repository === undefined || baseBranch === null
      ? unlistedFiles
      : newThreadFilesAtom(placeKey(where.place), repository, baseBranch),
  )

  const models = Option.getOrNull(AsyncResult.value(offered))

  const model =
    props.choice.model === null
      ? models?.defaultModel
      : models?.models.find(({ id }) => id === props.choice.model)

  const choice: HarnessChoice =
    models === null
      ? props.choice
      : {
          ...props.choice,
          model: model === undefined ? null : props.choice.model,
          effort: model?.efforts.includes(props.choice.effort ?? "") ? props.choice.effort : null,
        }

  const awaitingModels = models === null && (choice.model !== null || choice.effort !== null)

  const chooseModel = useCallback(
    (picked: ModelChoice) =>
      setChoice({ harness: choice.harness, permissionMode: choice.permissionMode, ...picked }),
    [setChoice, choice.harness, choice.permissionMode],
  )

  const choosePermissionMode = useCallback(
    (chosen: PermissionMode) =>
      setChoice({
        harness: choice.harness,
        model: choice.model,
        effort: choice.effort,
        permissionMode: chosen,
      }),
    [setChoice, choice.harness, choice.model, choice.effort],
  )

  const chooseHarness = useCallback(
    (harness: AgentHarness) =>
      setChoice({ harness, model: null, effort: null, permissionMode: null }),
    [setChoice],
  )

  const harnessChoice = useMemo(
    () => ({ options: where.harnesses, onChange: chooseHarness }),
    [where.harnesses, chooseHarness],
  )

  const [starting, setStarting] = useState<
    (MessageInput & { readonly key: string; readonly baseBranch: string }) | null
  >(null)

  const send = async (message: MessageInput) => {
    if (repository === undefined || key === undefined || baseBranch === null || awaitingModels)
      return false

    await document.startViewTransition({
      types: ["start-thread"],
      update: () => flushSync(() => setStarting({ ...message, key, baseBranch })),
    }).updateCallbackDone

    const exit = await create({
      repository,
      baseBranch,
      place: where.place,
      skillPacks: skills.chosen,
      localSkills: skills.sendsLocalSkills,
      ...choice,
      ...message,
    })

    if (Exit.isSuccess(exit))
      void navigate({
        to: "/threads/$threadId",
        params: { threadId: exit.value.id },
      })
    else setStarting(null)

    return Exit.isSuccess(exit)
  }

  return (
    <ThreadFrame
      label="New Thread"
      className="[&_[data-slot=input-group]]:[view-transition-name:new-thread-composer]"
      heading={
        <h1 className="truncate font-medium">
          {starting === null ? "New Thread" : "Starting Thread…"}
        </h1>
      }
      details={null}
    >
      {starting === null ? (
        <div className="flex flex-1 flex-col items-center justify-end gap-2 px-6 pb-4 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">What should we work on?</h2>
          <p className="max-w-md text-sm text-muted-foreground">{where.describe(key)}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <MessageGroup
            className={cn(threadColumn, "gap-4 [view-transition-name:new-thread-start]")}
          >
            <UserMessage message={starting.message} images={starting.images} />
            <Trace>
              <TraceLine status="running">
                <TraceIcon>
                  <LoaderCircle className="animate-spin" />
                </TraceIcon>
                <TraceTitle>{where.starting(starting.key, starting.baseBranch)}</TraceTitle>
              </TraceLine>
            </Trace>
          </MessageGroup>
        </div>
      )}
      <MessageBox
        composed={composed}
        setComposed={(update) => setWritten(update(composed))}
        label="Message"
        placeholder="What should the agent do?"
        blocked={
          created.waiting ||
          baseBranch === null ||
          awaitingModels ||
          !AsyncResult.isSuccess(skills.listed)
        }
        problem={
          settledProblem(created) ??
          settledProblem(skills.listed) ??
          settledProblem(skills.localNamesListed) ??
          settledProblem(defaults) ??
          settledProblem(branches) ??
          folder.problem
        }
        send={send}
        steer={null}
        beam
        recall={null}
        onStop={null}
        commands={commands}
        files={files}
        pickers={
          <>
            <ModelPicker
              harness={choice.harness}
              placeKey={placeKey(where.place)}
              model={choice.model}
              effort={choice.effort}
              onChange={chooseModel}
              harnessChoice={harnessChoice}
            />
            {asksPermission(where.place) && (
              <PermissionModePicker
                harness={choice.harness}
                permissionMode={choice.permissionMode ?? defaultPermissionMode}
                onChange={choosePermissionMode}
              />
            )}
          </>
        }
      >
        {starting === null && (
          <div className="flex min-w-0 flex-wrap items-center gap-1 [view-transition-name:new-thread-options] [&>button]:min-w-0">
            {props.providers.length > 0 && (
              <ChipSelect
                label="Where the Thread runs"
                icon={<PlaceIcon aria-hidden />}
                value={placeKey(where.place)}
                items={[
                  { value: placeKey(localPlace), label: placeNames["local"] },
                  ...props.providers.map((provider) => ({
                    value: placeKey(SandboxPlace.make({ providerId: provider.id })),
                    label: provider.name,
                  })),
                ]}
                onValueChange={(chosen) => props.onPlaceChange(placeOfKey(chosen))}
              />
            )}
            <ChipSelect
              label="Repository"
              icon={<FolderGit2 aria-hidden />}
              value={key ?? null}
              items={props.repositories.map((choosable) => ({
                value: repositoryKey(choosable.repository),
                label: repositoryKey(choosable.repository),
                title: choosable.title,
              }))}
              onValueChange={(chosen) =>
                void navigate({ to: "/threads/new", search: { repository: chosen } })
              }
              placeholder="No repositories"
              action={
                where.choosesFolder
                  ? {
                      label: "Choose folder…",
                      icon: <FolderPlus aria-hidden />,
                      onSelect: () => void folder.choose(),
                      disabled: folder.waiting,
                    }
                  : undefined
              }
            />
            <ChipSelect
              key={branchContext}
              label="Base branch"
              icon={<GitBranch aria-hidden />}
              value={baseBranch}
              items={(listed ?? (baseBranch === null ? [] : [baseBranch])).map((branch) => ({
                value: branch,
                label: branch,
              }))}
              onOpenChange={(open) => open && setBrowsed(branchContext)}
              onValueChange={(branch) => key !== undefined && props.setBase(branchContext, branch)}
              placeholder={key === undefined ? "No branches" : "Loading branches…"}
              disabled={Option.isNone(defaultBranch) || key === undefined}
            />
            <SkillPackPicker
              names={skills.names}
              chosen={skills.chosen}
              onChange={skills.setChosen}
            />
            {skills.offersLocalSkills && (
              <LocalSkillsToggle
                checked={skills.sendsLocalSkills}
                onCheckedChange={skills.setLocalSkills}
              />
            )}
            <SharedSkillNames shared={skills.shared} />
          </div>
        )}
      </MessageBox>
      {starting === null && <div className="flex-1" />}
    </ThreadFrame>
  )
}

const pickBase = (
  chosen: string | undefined,
  listed: ReadonlyArray<string> | null,
  defaultBranch: string | null,
) => {
  if (chosen === undefined) return defaultBranch

  if (listed === null) return null

  return listed.includes(chosen) ? chosen : defaultBranch
}

function PrefetchBranches(props: { checkout: LocalCheckout }) {
  useAtomValue(newThreadDefaultBranchAtom(placeKey(localPlace), props.checkout.repository))
  useAtomValue(newThreadBranchesAtom(placeKey(localPlace), props.checkout.repository))

  return null
}
