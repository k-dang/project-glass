import { useAtom } from "@effect/atom-react"
import {
  type ConversationPlace,
  type ConversationSkillPack,
  type PullRequestSummary,
  shortSha,
} from "@glass/contracts"
import { cn } from "cn"
import {
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Package,
  PanelRightClose,
  PanelRightOpen,
  PanelTop,
} from "lucide-react"
import { createContext, type ReactNode, use, useId, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ConversationPullRequestLink, PullRequestLink } from "./ConversationPullRequest"
import { ConversationsPanelToggle } from "./Conversations"
import { conversationDetailsPinnedAtom, placeIcons, placeNames } from "./conversationsArea"
import { LOCAL_SKILLS_LABEL } from "./skillChoice"

const fact =
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"

const action = "text-left outline-none hover:bg-accent focus-visible:bg-accent"

const wideWindow = window.matchMedia("(min-width: 1200px)")

const subscribeToWidth = (onChange: () => void) => {
  wideWindow.addEventListener("change", onChange)

  return () => wideWindow.removeEventListener("change", onChange)
}

const isWide = () => wideWindow.matches

const ClosePopover = createContext<() => void>(() => {})

export interface Details {
  place: ConversationPlace
  repository: string | undefined
  branch: string | undefined
  baseBranch: string | null
  pullRequest: PullRequestSummary | undefined
  skillPacks: ReadonlyArray<ConversationSkillPack>
  localSkills: boolean
  actions: ReactNode
}

export function ConversationFrame(props: {
  label: string
  className?: string
  heading: ReactNode
  details: Details | null
  sidePaneOpen?: boolean
  children: ReactNode
}) {
  const wide = useSyncExternalStore(subscribeToWidth, isWide)
  const [pinned, setPinned] = useAtom(conversationDetailsPinnedAtom)
  const detailsId = useId()
  const { details } = props
  const pins = wide && props.sidePaneOpen !== true
  const pinnedLabel = pinned ? "Hide details" : "Show details"
  const PinnedIcon = pinned ? PanelRightClose : PanelRightOpen

  return (
    <section
      aria-label={props.label}
      className={cn("flex min-h-0 flex-1 flex-col", props.className)}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-sm">
        <ConversationsPanelToggle />
        <div className="flex min-w-0 flex-1 items-center gap-2">{props.heading}</div>
        {details?.pullRequest !== undefined && (
          <ConversationPullRequestLink pullRequest={details.pullRequest} />
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
              <PinnedIcon aria-hidden />
            </Button>
          ) : (
            <DetailsPopover details={details} />
          ))}
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{props.children}</div>
        {details !== null && pins && pinned && (
          <aside
            id={detailsId}
            aria-label="Details"
            className="w-64 shrink-0 overflow-y-auto border-l p-1"
          >
            <ConversationDetails {...details} />
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
          <ConversationDetails {...props.details} />
        </ClosePopover>
      </PopoverContent>
    </Popover>
  )
}

function ConversationDetails(props: Details) {
  const PlaceIcon = placeIcons[props.place._tag]

  const skillSources = [
    ...props.skillPacks.map(({ name, commit }) => `${name} @ ${shortSha(commit)}`),
    ...(props.localSkills ? [LOCAL_SKILLS_LABEL] : []),
  ]

  return (
    <>
      <div className={fact}>
        <PlaceIcon aria-hidden />
        {placeNames[props.place._tag]}
      </div>
      <div className={fact}>
        <FolderGit2 aria-hidden />
        <span className="truncate">{props.repository ?? "No repository"}</span>
      </div>
      {props.baseBranch !== null && (
        <>
          <div className="-mx-1 my-1 border-t" />
          <div className={fact}>
            <GitBranch aria-hidden />
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
          <Package aria-hidden />
          <span className="truncate">{skillSources.join(" · ")}</span>
        </div>
      )}
      {props.actions}
    </>
  )
}

function DetailsPullRequestLink(props: { pullRequest: PullRequestSummary }) {
  const close = use(ClosePopover)
  const { pullRequest } = props

  return (
    <PullRequestLink
      href={pullRequest.url}
      pullRequest={pullRequest.ref}
      onClick={close}
      className={cn(fact, action)}
    >
      <GitPullRequest aria-hidden />
      <span className="truncate">{pullRequest.title}</span>
      <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
        #{pullRequest.ref.number}
      </span>
    </PullRequestLink>
  )
}

export function ConversationDetailsAction(props: { onNavigate: () => void; children: ReactNode }) {
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
