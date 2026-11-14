import { Duration, Match } from "effect"

const LOST_AFTER_MISSES = 4

const QUICK_RETRY_SPACING = Duration.millis(500)

const FIRST_LOST_RETRY_SPACING = Duration.seconds(5)

const MAX_LOST_RETRY_SPACING = Duration.minutes(5)

const GIVE_UP_AFTER = Duration.minutes(15)

type Reach = "connecting" | "reachable" | "unreachable"

export type Recovery<Client> =
  | { readonly phase: "connecting"; readonly reach: Reach }
  | { readonly phase: "reachable"; readonly client: Client }
  | {
      readonly phase: "retrying"
      readonly reach: Reach
      readonly misses: number
      readonly delay: Duration.Duration
    }
  | {
      readonly phase: "unreachable"
      readonly misses: number
      readonly lostFor: Duration.Duration
      readonly delay: Duration.Duration
    }
  | { readonly phase: "abandoned" }

export const recoveryReach = <C>(state: Recovery<C>) =>
  Match.value(state).pipe(
    Match.withReturnType<Reach>(),
    Match.discriminatorsExhaustive("phase")({
      connecting: ({ reach }) => reach,
      reachable: () => "reachable",
      retrying: ({ reach }) => reach,
      unreachable: () => "unreachable",
      abandoned: () => "unreachable",
    }),
  )

export const missedConnection = <C>(state: Recovery<C>): Recovery<C> => {
  if (state.phase === "abandoned") return state

  const misses = state.phase === "retrying" || state.phase === "unreachable" ? state.misses + 1 : 1

  if (misses < LOST_AFTER_MISSES)
    return {
      phase: "retrying",
      reach: recoveryReach(state),
      misses,
      delay: QUICK_RETRY_SPACING,
    }

  const lostFor = state.phase === "unreachable" ? state.lostFor : Duration.zero

  if (Duration.isGreaterThanOrEqualTo(lostFor, GIVE_UP_AFTER)) return { phase: "abandoned" }

  const delay = Duration.min(
    Duration.times(FIRST_LOST_RETRY_SPACING, 2 ** (misses - LOST_AFTER_MISSES)),
    MAX_LOST_RETRY_SPACING,
  )

  return { phase: "unreachable", misses, lostFor: Duration.sum(lostFor, delay), delay }
}
