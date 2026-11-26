import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { REVIEW_SCRIPT, type ReviewScript } from "./scriptedAdapter"

export const scriptedReviews = (gates: string) => {
  let gate = 0

  const script = (next: ReviewScript) =>
    Effect.sync(() => writeFileSync(join(gates, REVIEW_SCRIPT), JSON.stringify(next)))

  return {
    script,
    hold: Effect.suspend(() => script({ hold: `release-${++gate}` })),
    release: (next: ReviewScript) =>
      script(next).pipe(
        Effect.andThen(Effect.sync(() => writeFileSync(join(gates, `release-${gate}`), ""))),
      ),
  }
}
