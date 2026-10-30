import { TooltipHint } from "@/components/ui/tooltip"
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import {
  type Activity,
  type ActivityPullRequest,
  type LoggedActivity,
  repositoryKey,
  type ReviewDecision,
} from "@glass/contracts"
import { cn } from "cn"
import { DateTime, Effect, Match } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import {
  CircleCheck,
  CirclePlus,
  Eye,
  FileDiff,
  GitPullRequest,
  type LucideIcon,
  MessageSquare,
  RefreshCw,
  Reply,
  Sparkles,
  SquareCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Backend, backendRuntime } from "./backend"
import { Empty, LoadMore } from "./Lists"
import { plural } from "./plural"
import { placeNames } from "./agentsArea"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"
import { dayOf } from "./recency"

export const ACTIVITY_PAGE_SIZE = 100

const CACHE_IDLE_TTL = "5 minutes"

const limitAtom = Atom.make(ACTIVITY_PAGE_SIZE).pipe(Atom.setIdleTTL(CACHE_IDLE_TTL))

const activityAtom = backendRuntime
  .atom((get) => {
    const limit = get(limitAtom)

    return Backend.use((backend) => backend.ListActivity({ limit })).pipe(
      Effect.map((page) => ({ page, limit })),
    )
  })
  .pipe(Atom.setIdleTTL(CACHE_IDLE_TTL))

interface Verb {
  readonly verb: string
  readonly icon: LucideIcon
  readonly tone?: string
}

interface Described extends Verb {
  readonly path?: string
  readonly subject: string
  readonly where?: string
  readonly written?: string | undefined
}

const decisions: Record<ReviewDecision, Verb> = {
  comment: { verb: "Reviewed", icon: MessageSquare },
  approve: { verb: "Approved", icon: CircleCheck, tone: "text-added" },
  "request-changes": { verb: "Requested changes", icon: FileDiff, tone: "text-deleted" },
}

const unlessBlank = (text: string) => (text.trim() === "" ? undefined : text)

const onPullRequest = ({ ref, title }: ActivityPullRequest) => ({
  subject: title,
  where: `${ref.owner}/${ref.repo}#${ref.number}`,
})

const describe = (activity: Activity): Described =>
  Match.valueTags(activity, {
    PullRequestOpened: ({ pullRequest }) => ({
      verb: "Opened",
      icon: GitPullRequest,
      ...onPullRequest(pullRequest),
    }),
    FileViewed: ({ pullRequest, path }) => ({
      verb: "Viewed",
      icon: Eye,
      path,
      ...onPullRequest(pullRequest),
    }),
    ReviewSubmitted: ({ pullRequest, decision, summary, drafts }) => {
      const described = decisions[decision]

      return {
        ...described,
        verb:
          drafts.length === 0
            ? described.verb
            : `${described.verb} with ${plural(drafts.length, "Draft")}`,
        written: unlessBlank(summary),
        ...onPullRequest(pullRequest),
      }
    },
    ReplySent: ({ pullRequest, body }) => ({
      verb: "Replied",
      icon: Reply,
      written: unlessBlank(body),
      ...onPullRequest(pullRequest),
    }),
    ToDoAdded: ({ toDo }) => ({ verb: "Added to-do", icon: CirclePlus, subject: toDo.title }),
    ToDoDone: ({ toDo }) => ({
      verb: "Marked done",
      icon: SquareCheck,
      tone: "text-added",
      subject: toDo.title,
    }),
    AgentStarted: ({ name, repository, machine, message }) => ({
      verb: "Started Agent",
      icon: Sparkles,
      subject: name,
      where: `${repositoryKey(repository)} on ${placeNames[machine]}`,
      written: unlessBlank(message),
    }),
  })

export function ActivityLogPage() {
  const result = useAtomValue(activityAtom)

  const refresh = useAtomRefresh(activityAtom)

  const [limit, setLimit] = useAtom(limitAtom)

  return (
    <div className="page-content flex flex-col py-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh"
          className="ml-auto"
          onClick={refresh}
        >
          <RefreshCw className={cn(result.waiting && "animate-spin")} aria-hidden />
        </Button>
      </div>
      {AsyncResult.builder(result)
        .onSuccess((loaded) => (
          <LoadedLog
            activities={loaded.page.activities}
            hasMore={loaded.page.hasMore}
            loading={result.waiting && limit > loaded.limit}
            refreshing={result.waiting}
            onMore={() => setLimit(limit + ACTIVITY_PAGE_SIZE)}
          />
        ))
        .onFailure((cause) => (
          <div className="py-4">
            <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: refresh }} />
          </div>
        ))
        .orElse(() => (
          <output className="py-6 text-sm text-muted-foreground">Loading Activity…</output>
        ))}
    </div>
  )
}

function LoadedLog(props: {
  activities: ReadonlyArray<LoggedActivity>
  hasMore: boolean
  loading: boolean
  refreshing: boolean
  onMore: () => void
}) {
  if (props.activities.length === 0) {
    return (
      <Empty title="No Activity yet">
        <p>
          PRs you open, files you view, Reviews and Replies you send, and to-dos you add and finish
          in Glass appear here.
        </p>
      </Empty>
    )
  }

  return (
    <>
      <ActivityDays activities={props.activities} />
      {props.hasMore && (
        <LoadMore
          label="Load more"
          loading={props.loading}
          disabled={props.refreshing}
          onMore={props.onMore}
        />
      )}
    </>
  )
}

function ActivityDays(props: { activities: ReadonlyArray<LoggedActivity> }) {
  const now = new Date()

  const days = Map.groupBy(props.activities, ({ occurredAt }) =>
    dayOf(DateTime.toDateUtc(occurredAt), now),
  )

  return [...days].map(([day, activities]) => (
    <section key={day} aria-label={day} className="pt-2">
      <h2 className="px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground">{day}</h2>
      <ul>
        {activities.map((logged) => (
          <ActivityRow key={logged.id} logged={logged} />
        ))}
      </ul>
    </section>
  ))
}

function ActivityRow(props: { logged: LoggedActivity }) {
  const { activity, occurredAt } = props.logged

  const {
    verb,
    icon: Icon,
    tone = "text-muted-foreground",
    path,
    subject,
    where,
    written,
  } = describe(activity)

  const at = DateTime.toDateUtc(occurredAt)

  return (
    <li className="flex items-start gap-2.5 px-2.5 py-2 text-sm">
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-medium">{verb}</span>
          {path !== undefined && <span className="min-w-0 truncate font-mono text-xs">{path}</span>}
          <span className="min-w-12 truncate text-muted-foreground">{subject}</span>
          {where !== undefined && (
            <span className="shrink-0 text-xs text-muted-foreground">{where}</span>
          )}
        </span>
        {written !== undefined && (
          <span className="line-clamp-2 whitespace-pre-line text-muted-foreground">{written}</span>
        )}
      </span>
      <TooltipHint content={at.toLocaleString()}>
        <time
          dateTime={at.toISOString()}
          className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </time>
      </TooltipHint>
    </li>
  )
}
