// PROTOTYPE: three compact variants of the PR workspace header, switchable with the
// floating bar (Alt+← / Alt+→); the choice persists in localStorage. Never merge to main.
import type { PullRequest, Revision } from "@glass/contracts"
import { cn } from "cn"
import { ArrowLeft, ChevronDown, ChevronRight, RotateCw } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TooltipHint } from "@/components/ui/tooltip"
import { StatusChips } from "./PullRequestStatus"
import { ShortSha } from "./shortSha"
import { useShortcuts } from "./useShortcuts"
import { badges, Branch, PullRequestHeader, StateBadge } from "./Workspace"
import { PrototypeSwitcher, usePrototypeVariant } from "./PrototypeSwitcher"

type HeaderProps = {
  pullRequest: PullRequest
  revision: Revision
  reloading: boolean
  changedOnGitHub: boolean
  busy: boolean
  onReload: () => void
  onBack: () => void
  open: ReactNode
  review: ReactNode
  tabs: ReactNode
}

const variants = [
  { key: "A", name: "One row, details in a popover" },
  { key: "B", name: "Two rows, tabs share the meta row" },
  { key: "C", name: "Breadcrumb strip, actions on the tab row" },
  { key: "0", name: "Current header" },
]

export function PullRequestHeaderPrototype(props: HeaderProps) {
  const [variant, setVariant] = usePrototypeVariant(variants.map(({ key }) => key))

  return (
    <>
      {variant === "A" && <VariantA {...props} />}
      {variant === "B" && <VariantB {...props} />}
      {variant === "C" && <VariantC {...props} />}
      {variant === "0" && <PullRequestHeader {...props} />}
      <PrototypeSwitcher variants={variants} current={variant} onChange={setVariant} />
    </>
  )
}

function useBack(props: HeaderProps) {
  useShortcuts([{ key: "Escape", run: () => !props.busy && props.onBack() }])
}

function BackIcon(props: HeaderProps) {
  useBack(props)

  return (
    <TooltipHint content="Back to PRs (Esc)">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back to PRs"
        aria-keyshortcuts="Escape"
        onClick={props.onBack}
        disabled={props.busy}
      >
        <ArrowLeft aria-hidden />
      </Button>
    </TooltipHint>
  )
}

function ReloadIcon(props: HeaderProps) {
  return (
    <TooltipHint
      content={
        <>
          {props.changedOnGitHub
            ? "Changed on GitHub since Glass loaded it. Reload to see it as it is now."
            : "Reload at the current revision"}{" "}
          · Head <ShortSha sha={props.revision.head} />
        </>
      }
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Reload"
        onClick={props.onReload}
        disabled={props.busy}
        className={cn(props.changedOnGitHub && "bg-amber-500/15 text-amber-300")}
      >
        <RotateCw className={props.reloading ? "animate-spin" : undefined} aria-hidden />
      </Button>
    </TooltipHint>
  )
}

function StateIcon(props: { pullRequest: PullRequest }) {
  const { label, icon: Icon, className } = badges[props.pullRequest.state]

  return (
    <TooltipHint content={label}>
      <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full", className)}>
        <Icon aria-label={label} className="size-3" />
      </span>
    </TooltipHint>
  )
}

function Repo(props: { pullRequest: PullRequest }) {
  const { owner, repo } = props.pullRequest.ref

  return (
    <span>
      {owner}/{repo}
    </span>
  )
}

function Branches(props: { pullRequest: PullRequest }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Branch name={props.pullRequest.baseBranch} />
      <span aria-label="from">←</span>
      <Branch name={props.pullRequest.headBranch} />
    </span>
  )
}

// A: everything on one 44px row. Repo, author, branches, and status chips move
// into a popover on the title; the tabs sit inline after it.
function VariantA(props: HeaderProps) {
  const { pullRequest } = props

  return (
    <header className="flex h-11 items-center gap-2 border-b pr-3 pl-2">
      <BackIcon {...props} />
      <StateIcon pullRequest={pullRequest} />
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 shrink items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-muted"
            />
          }
        >
          <h1 className="min-w-0 truncate text-sm font-semibold">
            {pullRequest.title}{" "}
            <span className="font-normal text-muted-foreground">#{pullRequest.ref.number}</span>
          </h1>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto max-w-xl gap-2 p-3 text-sm">
          <div className="font-semibold">{pullRequest.title}</div>
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <StateBadge pullRequest={pullRequest} />
            <Repo pullRequest={pullRequest} />
            <span aria-hidden>·</span>
            <span className="font-medium text-foreground">{pullRequest.author}</span>
          </div>
          <Branches pullRequest={pullRequest} />
          <div className="flex flex-wrap items-center gap-1">
            <StatusChips pullRequest={pullRequest} />
          </div>
        </PopoverContent>
      </Popover>
      <div className="ml-2 h-full shrink-0 [&_[role=tablist]]:h-full!">{props.tabs}</div>
      <div className="ml-auto flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
        {props.open}
        <ReloadIcon {...props} />
        {props.review}
      </div>
    </header>
  )
}

// B: two rows. Row one is identity and actions; row two puts the tabs on the
// left and the status the reviewer scans (branches, checks) on the right.
function VariantB(props: HeaderProps) {
  const { pullRequest } = props

  return (
    <header className="flex flex-col border-b px-4">
      <div className="flex h-11 items-center gap-2">
        <BackIcon {...props} />
        <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">
          {pullRequest.title}{" "}
          <span className="font-normal text-muted-foreground">#{pullRequest.ref.number}</span>
        </h1>
        <span className="hidden shrink-0 text-sm text-muted-foreground xl:inline">
          <Repo pullRequest={pullRequest} /> by{" "}
          <span className="font-medium text-foreground">{pullRequest.author}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
          {props.open}
          <ReloadIcon {...props} />
          {props.review}
        </div>
      </div>
      <div className="flex h-9 items-center gap-4">
        {props.tabs}
        <div className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden text-sm text-muted-foreground">
          <StateBadge pullRequest={pullRequest} />
          <Branches pullRequest={pullRequest} />
          <span aria-hidden className="mx-1">
            ·
          </span>
          <StatusChips pullRequest={pullRequest} />
        </div>
      </div>
    </header>
  )
}

// C: the title becomes the last crumb of a slim breadcrumb (PRs › repo › title),
// with status on the same strip. Actions move down to the tab row.
function VariantC(props: HeaderProps) {
  const { pullRequest } = props
  useBack(props)

  return (
    <header className="flex flex-col border-b px-4">
      <div className="flex h-9 items-center gap-1.5 text-sm text-muted-foreground">
        <button
          type="button"
          onClick={props.onBack}
          disabled={props.busy}
          title="Back to PRs (Esc)"
          className="shrink-0 rounded px-1 hover:bg-muted hover:text-foreground"
        >
          Pull requests
        </button>
        <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">
          <Repo pullRequest={pullRequest} />
        </span>
        <ChevronRight aria-hidden className="size-3.5 shrink-0" />
        <StateIcon pullRequest={pullRequest} />
        <h1 className="min-w-0 truncate font-semibold text-foreground">
          {pullRequest.title}{" "}
          <span className="font-normal text-muted-foreground">#{pullRequest.ref.number}</span>
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-4">
          <StatusChips pullRequest={pullRequest} />
        </div>
      </div>
      <div className="flex h-10 items-center gap-3">
        {props.tabs}
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:flex lg:items-center lg:gap-2">
          <span className="font-medium text-foreground">{pullRequest.author}</span>
          <Branches pullRequest={pullRequest} />
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
          {props.open}
          <ReloadIcon {...props} />
          {props.review}
        </div>
      </div>
    </header>
  )
}
