import { Context, Effect, Option } from "effect"

const idle = {
  notify: (_progress: number) => Effect.void,
}

export class AskProgress extends Context.Service<
  AskProgress,
  { readonly notify: (progress: number) => Effect.Effect<void> }
>()("@glass/server/AskProgress") {
  static readonly current = Effect.serviceOption(AskProgress).pipe(
    Effect.map(Option.getOrElse(() => idle)),
  )
}
