import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  type Agent,
  AgentEngine,
  type AgentPlace,
  asksPermission,
  Branches,
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
  thisMac,
} from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { Exit, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { FolderGit2, FolderPlus, GitBranch, LoaderCircle } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { MessageGroup } from "@/components/ui/message"
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import {
  agentsAtom,
  branchesAtom,
  writtenAtom,
  createAgentAtom,
  gitHubBranchesAtom,
  linkCheckoutAtom,
  localCheckoutsAtom,
  placeNames,
  sandboxProvidersAtom,
  placeIcons,
  placeKey,
  placeOfKey,
} from "./agentsArea"
import { AgentHeader } from "./AgentHeader"
import { UserMessage } from "./AgentView"
import type { BackendError } from "./backend"
import { ChipSelect } from "./chips"
import { repositoriesAtom } from "./FollowedRepositories"
import { MessageBox } from "./MessageBox"
import { ModelPicker } from "./ModelPicker"
import { PermissionModePicker } from "./PermissionModePicker"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, settledProblem } from "./problems"

const NEW_AGENT_TEXT = "new"

/** A `null` Permission mode starts a program that has them in `defaultPermissionMode`. */
type Program = {
  readonly engine: AgentEngine
  readonly permissionMode: PermissionMode | null
} & ModelChoice

interface Choosable {
  readonly repository: FollowedRepository
  readonly title?: string | undefined
}

interface PlaceOptions {
  readonly place: AgentPlace
  readonly branches: (
    repository: FollowedRepository,
  ) => Atom.Atom<AsyncResult.AsyncResult<Branches, BackendError>>
  readonly describe: (key: string | undefined) => string
  readonly starting: (key: string, baseBranch: string) => string
  readonly choosesFolder: boolean
  readonly engines: readonly [AgentEngine, ...Array<AgentEngine>]
}

const onThisMac: PlaceOptions = {
  place: thisMac,
  branches: branchesAtom,
  describe: (key) =>
    key === undefined
      ? "Choose a folder you cloned a GitHub repository into."
      : "The Agent works on a branch of its own.",
  starting: (key, baseBranch) => `Making the Agent's copy of ${key} from ${baseBranch}…`,
  choosesFolder: true,
  engines: AgentEngine.literals,
}

const inSandboxOf = ({ id, name, engines }: SandboxProviderInfo): PlaceOptions => ({
  place: SandboxPlace.make({ providerId: id }),
  branches: gitHubBranchesAtom,
  describe: (key) =>
    key === undefined
      ? "Follow a repository in Settings to get started."
      : "The Agent works on a branch of its own.",
  starting: () => `Starting the Agent in a Sandbox from ${name}…`,
  choosesFolder: false,
  engines,
})

export const defaultPlace = (
  newest: Agent | undefined,
  providers: ReadonlyArray<SandboxProviderInfo>,
  hasCheckouts: boolean,
): AgentPlace => {
  const available = (place: AgentPlace) =>
    Predicate.isTagged(place, "sandbox")
      ? providers.some(({ id }) => id === place.providerId)
      : hasCheckouts

  if (newest !== undefined && available(newest.place)) return newest.place

  const first = providers[0]

  return hasCheckouts || first === undefined ? thisMac : SandboxPlace.make({ providerId: first.id })
}

const noBranches: Atom.Atom<AsyncResult.AsyncResult<Branches, BackendError>> = Atom.make(
  AsyncResult.success(new Branches({ defaultBranch: null, branches: [] })),
)

export function NewAgent(props: { repository: string | undefined }) {
  const checkouts = useAtomValue(localCheckoutsAtom)

  const providers = Option.getOrElse(
    AsyncResult.value(useAtomValue(sandboxProvidersAtom)),
    (): ReadonlyArray<SandboxProviderInfo> => [],
  )

  const agents = Option.getOrElse(AsyncResult.value(useAtomValue(agentsAtom)), () => [])

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
        newest={agents.at(-1)}
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
        to: "/agents/new",
        search: { repository: repositoryKey(exit.value.repository) },
      })
  }

  return { choose, waiting: linked.waiting, problem: settledProblem(linked) }
}

interface DraftChoices {
  readonly providers: ReadonlyArray<SandboxProviderInfo>
  readonly where: PlaceOptions
  readonly onPlaceChange: (place: AgentPlace) => void
  readonly program: Program
  readonly setProgram: (program: Program) => void
  readonly repository: string | undefined
  readonly newest: Agent | undefined
}

function ChoosePlace(props: {
  checkouts: ReadonlyArray<LocalCheckout>
  providers: ReadonlyArray<SandboxProviderInfo>
  repository: string | undefined
  newest: Agent | undefined
}) {
  const { newest, providers } = props
  const [chosenPlace, setChosenPlace] = useState<AgentPlace | null>(null)
  const [chosenProgram, setChosenProgram] = useState<Program | null>(null)
  const place = chosenPlace ?? defaultPlace(newest, providers, props.checkouts.length > 0)

  const provider = Predicate.isTagged(place, "sandbox")
    ? providers.find(({ id }) => id === place.providerId)
    : undefined

  const where = provider === undefined ? onThisMac : inSandboxOf(provider)

  const preferred: Program =
    chosenProgram ??
    (newest === undefined
      ? { engine: "claude-code", model: null, effort: null, permissionMode: null }
      : {
          engine: newest.engine,
          model: newest.model,
          effort: newest.effort,
          permissionMode: null,
        })

  const program: Program = where.engines.includes(preferred.engine)
    ? preferred
    : { engine: where.engines[0], model: null, effort: null, permissionMode: null }

  const choices: DraftChoices = {
    providers,
    where,
    onPlaceChange: (chosen) => {
      setChosenPlace(chosen)
      const placeChanged = placeKey(chosen) !== placeKey(where.place)

      if (placeChanged)
        setChosenProgram({
          engine: program.engine,
          model: null,
          effort: null,
          permissionMode: null,
        })
    },
    program,
    setProgram: setChosenProgram,
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
  const { where, program, setProgram, newest } = props
  const navigate = useNavigate()
  const folder = useChooseFolder()
  const PlaceIcon = placeIcons[where.place._tag]
  const [written, setWritten] = useAtom(writtenAtom(NEW_AGENT_TEXT))
  const composed = written ?? nothingUnsent

  const find = (key: string | undefined) =>
    props.repositories.find(({ repository }) => repositoryKey(repository) === key)?.repository

  const repository =
    find(props.repository) ??
    find(newest === undefined ? undefined : repositoryKey(newest.repository)) ??
    props.repositories[0]?.repository

  const branches = useAtomValue(repository === undefined ? noBranches : where.branches(repository))

  const created = useAtomValue(createAgentAtom)
  const create = useAtomSet(createAgentAtom, { mode: "promiseExit" })
  const [chosenBase, setChosenBase] = useState<{ repository: string; branch: string } | null>(null)
  const listed = Option.getOrNull(AsyncResult.value(branches))
  const key = repository === undefined ? undefined : repositoryKey(repository)

  const baseBranch =
    (chosenBase !== null && chosenBase.repository === key ? chosenBase.branch : null) ??
    listed?.defaultBranch ??
    null

  const chooseModel = useCallback(
    (choice: ModelChoice) =>
      setProgram({ engine: program.engine, permissionMode: program.permissionMode, ...choice }),
    [setProgram, program.engine, program.permissionMode],
  )

  const choosePermissionMode = useCallback(
    (chosen: PermissionMode) =>
      setProgram({
        engine: program.engine,
        model: program.model,
        effort: program.effort,
        permissionMode: chosen,
      }),
    [setProgram, program.engine, program.model, program.effort],
  )

  const chooseEngine = useCallback(
    (engine: AgentEngine) =>
      setProgram({ engine, model: null, effort: null, permissionMode: null }),
    [setProgram],
  )

  const programs = useMemo(
    () => ({ engines: where.engines, onChange: chooseEngine }),
    [where.engines, chooseEngine],
  )

  const [starting, setStarting] = useState<
    (MessageInput & { readonly key: string; readonly baseBranch: string }) | null
  >(null)

  const send = async (message: MessageInput) => {
    if (repository === undefined || key === undefined || baseBranch === null) return false

    setStarting({ ...message, key, baseBranch })

    const exit = await create({
      repository,
      baseBranch,
      place: where.place,
      ...program,
      ...message,
    })

    if (Exit.isSuccess(exit))
      void navigate({ to: "/agents/$agentId", params: { agentId: exit.value.id } })
    else setStarting(null)

    return Exit.isSuccess(exit)
  }

  return (
    <section aria-label="New Agent" className="flex min-h-0 flex-1 flex-col">
      <AgentHeader
        heading={
          <h1 className="truncate font-medium">
            {starting === null ? "New Agent" : "Starting Agent…"}
          </h1>
        }
        place={where.place}
        repository={key}
        baseBranch={baseBranch}
      />
      {starting === null ? (
        <div className="flex flex-1 flex-col items-center justify-end gap-2 px-6 pb-4 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">What should we work on?</h2>
          <p className="max-w-md text-sm text-muted-foreground">{where.describe(key)}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <MessageGroup className="mx-auto max-w-3xl gap-4">
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
        placeholder="What should the Agent do?"
        blocked={created.waiting || baseBranch === null}
        problem={settledProblem(created) ?? settledProblem(branches) ?? folder.problem}
        send={send}
        steer={null}
        recall={null}
        onStop={null}
        pickers={
          <>
            <ModelPicker
              engine={program.engine}
              placeKey={placeKey(where.place)}
              model={program.model}
              effort={program.effort}
              onChange={chooseModel}
              programs={programs}
            />
            {asksPermission(where.place) && (
              <PermissionModePicker
                engine={program.engine}
                permissionMode={program.permissionMode ?? defaultPermissionMode}
                onChange={choosePermissionMode}
              />
            )}
          </>
        }
      >
        <div className="flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1">
            {props.providers.length > 0 && (
              <ChipSelect
                label="Where the Agent runs"
                icon={<PlaceIcon aria-hidden />}
                value={placeKey(where.place)}
                items={[
                  { value: placeKey(thisMac), label: placeNames["this-mac"] },
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
                void navigate({ to: "/agents/new", search: { repository: chosen } })
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
          </div>
          <ChipSelect
            label="Base branch"
            icon={<GitBranch aria-hidden />}
            value={baseBranch}
            items={(listed?.branches ?? []).map((branch) => ({ value: branch, label: branch }))}
            onValueChange={(branch) =>
              key !== undefined && setChosenBase({ repository: key, branch })
            }
            placeholder={key === undefined ? "No branches" : "Loading branches…"}
            disabled={listed === null || key === undefined}
          />
        </div>
      </MessageBox>
      {starting === null && <div className="flex-1" />}
    </section>
  )
}

function PrefetchBranches(props: { checkout: LocalCheckout }) {
  useAtomValue(branchesAtom(props.checkout.repository))

  return null
}
