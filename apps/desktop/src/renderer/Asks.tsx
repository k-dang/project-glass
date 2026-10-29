import { LoaderCircle, Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LineLocation, pathLineName } from "./Discussions"
import { runnerLabel } from "./engines"
import { ProblemAlert } from "./ProblemAlert"
import { TourText } from "./TourText"
import { type AskStore, useAsk } from "./useAsks"

export function LineAsk(props: { store: AskStore; askKey: string }) {
  const { store } = props
  const view = useAsk(store, props.askKey)

  if (view === undefined) return null

  const { place, state } = view
  const name = pathLineName(place.path, place.side, place.line)

  return (
    <section
      aria-label={`Ask on ${name}`}
      className="overflow-hidden rounded-lg border border-primary/25 bg-primary/[0.03] font-sans"
    >
      <header className="flex items-center gap-2 border-b border-primary/15 px-3 py-2 text-sm">
        <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          Ask on <LineLocation side={place.side} line={place.line} />
        </span>
        <span className="text-xs text-muted-foreground">Only you can see this</span>
      </header>
      <div className="flex flex-col gap-2 p-3 text-sm">
        <p className="m-0 font-medium wrap-anywhere whitespace-pre-wrap">{view.question}</p>
        {state.status === "pending" && (
          <p className="m-0 flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            <span className="flex-1">The agent is reading the PR's code…</span>
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Cancel question on ${name}`}
              onClick={() => store.remove(view.key)}
            >
              Cancel
            </Button>
          </p>
        )}
        {state.status === "answered" && (
          <>
            <p className="m-0 leading-[1.7] whitespace-pre-wrap text-muted-foreground wrap-anywhere">
              <TourText text={state.answer.answer} />
            </p>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {runnerLabel(state.answer.runner)}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Dismiss answer on ${name}`}
                onClick={() => store.remove(view.key)}
              >
                <X aria-hidden />
              </Button>
            </div>
          </>
        )}
        {state.status === "failed" && (
          <>
            <ProblemAlert
              problem={state.problem}
              action={{ label: "Retry", run: () => store.retry(view.key) }}
            />
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Dismiss question on ${name}`}
                onClick={() => store.remove(view.key)}
              >
                <X aria-hidden />
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
