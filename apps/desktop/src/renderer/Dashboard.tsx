import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { ResumableDestination } from "@glass/contracts"
import { Link } from "@tanstack/react-router"
import { Match } from "effect"
import { AsyncResult } from "effect/reactivity"
import { AgentContinueCard } from "./AgentContinueCard"
import { rememberPlaceHint } from "./ContinueCard"
import { Empty } from "./Lists"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"
import { ReviewContinueCard } from "./ReviewContinueCard"
import { loadedPlacesAtom, savedDestinationsAtom } from "./savedPlace"

function ContinueDestination(props: { destination: ResumableDestination }) {
  return Match.value(props.destination).pipe(
    Match.discriminatorsExhaustive("area")({
      reviews: (review) => <ReviewContinueCard destination={review} />,
      agents: (agent) => <AgentContinueCard destination={agent} />,
    }),
  )
}

export function Dashboard() {
  const result = useAtomValue(savedDestinationsAtom)
  const retry = useAtomRefresh(loadedPlacesAtom)

  return (
    <div className="page-content flex flex-col gap-8 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <section aria-labelledby="continue-heading" className="flex flex-col gap-4">
        <h2 id="continue-heading" className="text-base font-semibold">
          Continue where you left off
        </h2>
        {AsyncResult.builder(result)
          .onSuccess((destinations) => {
            const continued = [
              destinations.find(({ area }) => area === "reviews"),
              destinations.find(({ area }) => area !== "reviews"),
            ].filter((destination) => destination !== undefined)

            return continued.length === 0 ? (
              <Empty title="No saved place yet">
                {rememberPlaceHint}
                <Link
                  to="/reviews"
                  className="mt-3 inline-block text-foreground underline underline-offset-4"
                >
                  Browse pull requests
                </Link>
              </Empty>
            ) : (
              continued.map((destination) => (
                <ContinueDestination key={destination.area} destination={destination} />
              ))
            )
          })
          .onFailure((cause) => (
            <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: retry }} />
          ))
          .orElse(() => (
            <output className="py-6 text-sm text-muted-foreground">
              Loading your saved place…
            </output>
          ))}
      </section>
    </div>
  )
}
