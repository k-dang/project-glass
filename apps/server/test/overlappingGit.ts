import { Deferred, Effect, Layer } from "effect"
import { Git } from "../src/git"

export const overlappingGit = (commands: ReadonlyArray<string>) =>
  Layer.effect(
    Git,
    Effect.gen(function* () {
      const git = yield* Git
      const allStarted = yield* Deferred.make<void>()
      const started = new Set<string>()

      const held = <A, E>(args: ReadonlyArray<string>, run: Effect.Effect<A, E>) => {
        const command = args[0] ?? ""

        if (!commands.includes(command)) return run

        return Effect.gen(function* () {
          started.add(command)

          if (started.size === commands.length) yield* Deferred.succeed(allStarted, undefined)
          yield* Deferred.await(allStarted)

          return yield* run
        })
      }

      return Git.of({
        run: (cwd, args, env) => held(args, git.run(cwd, args, env)),
        runUntrimmed: (cwd, args) => held(args, git.runUntrimmed(cwd, args)),
        isolated: git.isolated,
      })
    }),
  ).pipe(Layer.provide(Git.layer))
