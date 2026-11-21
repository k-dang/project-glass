import { useAtom } from "@effect/atom-react"
import {
  type ThreadPlace,
  type ThreadPullRequest,
  type ThreadSkillPack,
  shortSha,
} from "@glass/contracts"
import { cn } from "cn"
import { Predicate } from "effect"
import { FolderGit2, GitBranch, GitPullRequest, Package, PanelTop } from "lucide-react"
import { createContext, type ReactNode, use, useId, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ThreadPullRequestLink, PullRequestLink, PullRequestStatusIcon } from "./ThreadPullRequest"
import { ThreadsPanelToggle } from "./Threads"
import { threadDetailsPinnedAtom, placeIcons, placeNames } from "./threadsArea"
import { LOCAL_SKILLS_LABEL } from "./skillChoice"

const fact =
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"

const action = "text-left outline-none hover:bg-accent focus-visible:bg-accent"

const wideWindow = window.matchMedia("(min-width: 1200px)")

const subscribeToWidth = (onChange: () => void) => {
  wideWindow.addEventListener("change", onChange)

  return () => wideWindow.removeEventListener("change", onChange)
}

const isWide = () => wideWindow.matches

const ClosePopover = createContext<() => void>(() => {})

export interface Details {
  place: ThreadPlace
  repository: string | undefined
  branch: string | undefined
  baseBranch: string | null
  pullRequest: ThreadPullRequest | undefined
  skillPacks: ReadonlyArray<ThreadSkillPack>
  localSkills: boolean
  actions: ReactNode
}

export function ThreadFrame(props: {
  label: string
  className?: string
  heading: ReactNode
  details: Details | null
  pinnable?: boolean
  children: ReactNode
}) {
  const wide = useSyncExternalStore(subscribeToWidth, isWide)
  const [pinned, setPinned] = useAtom(threadDetailsPinnedAtom)
  const detailsId = useId()
  const { details } = props
  const pins = wide && props.pinnable === true
  const pinnedLabel = pinned ? "Hide details" : "Show details"

  return (
    <section
      aria-label={props.label}
      className={cn("flex min-h-0 flex-1 flex-col", props.className)}
    >
      <header className="box-content flex h-11 shrink-0 items-center gap-2 border-b px-4 text-sm">
        <ThreadsPanelToggle />
        <div className="flex min-w-0 flex-1 items-center gap-2">{props.heading}</div>
        {details?.pullRequest !== undefined && (
          <ThreadPullRequestLink pullRequest={details.pullRequest} />
        )}
        {details !== null &&
          (pins ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={pinnedLabel}
              aria-expanded={pinned}
              aria-controls={detailsId}
              onClick={() => setPinned((open) => !open)}
            >
              <PanelTop aria-hidden />
            </Button>
          ) : (
            <DetailsPopover details={details} />
          ))}
      </header>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {props.children}
        {details !== null && pins && pinned && (
          <aside
            id={detailsId}
            aria-label="Details"
            className="absolute top-2 right-4 z-10 max-h-[calc(100%-1rem)] w-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          >
            <ThreadDetails {...details} />
          </aside>
        )}
      </div>
    </section>
  )
}

function DetailsPopover(props: { details: Details }) {
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(false)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (next) setInstant(false)
      }}
    >
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Details" />}>
        <PanelTop aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={cn("w-64 gap-0 p-1", instant && "data-ending-style:transition-none")}
      >
        <ClosePopover
          value={() => {
            setInstant(true)
            setOpen(false)
          }}
        >
          <ThreadDetails {...props.details} />
        </ClosePopover>
      </PopoverContent>
    </Popover>
  )
}

function ThreadDetails(props: Details) {
  const PlaceIcon = placeIcons[props.place._tag]

  const skillSources = [
    ...props.skillPacks.map(({ name, commit }) => `${name} @ ${shortSha(commit)}`),
    ...(props.localSkills ? [LOCAL_SKILLS_LABEL] : []),
  ]

  return (
    <>
      <div className={fact}>
        <PlaceIcon aria-hidden className="text-muted-foreground" />
        {placeNames[props.place._tag]}
      </div>
      <div className={fact}>
        <FolderGit2 aria-hidden className="text-muted-foreground" />
        <span className="truncate">{props.repository ?? "No repository"}</span>
      </div>
      {props.baseBranch !== null && (
        <>
          <div className="-mx-1 my-1 border-t" />
          <div className={fact}>
            <GitBranch aria-hidden className="text-muted-foreground" />
            {props.branch !== undefined && <span className="truncate">{props.branch}</span>}
            <span className="ml-auto shrink-0 text-muted-foreground">from {props.baseBranch}</span>
          </div>
          {props.pullRequest !== undefined && (
            <DetailsPullRequestLink pullRequest={props.pullRequest} />
          )}
        </>
      )}
      {skillSources.length > 0 && (
        <div className={fact}>
          <Package aria-hidden className="text-muted-foreground" />
          <span className="truncate">{skillSources.join(" · ")}</span>
        </div>
      )}
      {props.actions}
    </>
  )
}

function DetailsPullRequestLink(props: { pullRequest: ThreadPullRequest }) {
  const close = use(ClosePopover)
  const { pullRequest } = props

  return (
    <PullRequestLink
      href={pullRequest.url}
      pullRequest={pullRequest.ref}
      onClick={close}
      className={cn(fact, action)}
    >
      {Predicate.isTagged(pullRequest.state, "Open") ? (
        <GitPullRequest aria-hidden className="text-muted-foreground" />
      ) : (
        <PullRequestStatusIcon state={pullRequest.state} className="size-3.5" />
      )}
      <span className="truncate">{pullRequest.title}</span>
      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
        #{pullRequest.ref.number}
      </span>
    </PullRequestLink>
  )
}

export function ThreadDetailsAction(props: { onNavigate: () => void; children: ReactNode }) {
  const close = use(ClosePopover)

  return (
    <button
      type="button"
      onClick={() => {
        close()
        props.onNavigate()
      }}
      className={cn(fact, action)}
    >
      {props.children}
    </button>
  )
}
