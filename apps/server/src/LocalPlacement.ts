import { AgentEngine, AgentError, type FollowedRepository } from "@glass/contracts"
import { Context, Effect, Exit, FileSystem, Layer, Option, Stream } from "effect"
import { join } from "node:path"
import { shortAgentNames, uniqueAgentName } from "./agentNames"
import { Git, type GitFailed } from "./git"
import { LocalAgentHost } from "./LocalAgentHost"
import { LocalCheckouts } from "./LocalCheckouts"
import { asAgentError, type Placement, type PlacedAgent, type SubscribeLost } from "./Placement"
import { ServerConfig } from "./ServerConfig"

const gitFailure =
  (message: string) =>
  <A, R>(effect: Effect.Effect<A, GitFailed, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(message, cause)),
      Effect.mapError(() => new AgentError({ message })),
    )

const succeeds = <E, R>(effect: Effect.Effect<unknown, E, R>) =>
  effect.pipe(Effect.exit, Effect.map(Exit.isSuccess))

export class LocalPlacement extends Context.Service<
  LocalPlacement,
  Placement & { readonly subscribeLost: SubscribeLost }
>()("@glass/server/LocalPlacement") {
  static readonly layer = Layer.effect(
    LocalPlacement,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const git = yield* Git
      const checkouts = yield* LocalCheckouts
      const host = yield* LocalAgentHost
      const hosted = new Set<string>()

      const place = Effect.fn("LocalPlacement.place")(function* (
        repository: FollowedRepository,
        baseBranch: string,
      ) {
        const checkout = yield* checkouts.get(repository)

        const free = (candidate: string) =>
          Effect.findFirst(
            [`refs/heads/${candidate}`, `refs/remotes/${checkout.remote}/${candidate}`],
            (ref) => succeeds(git.run(checkout.path, ["show-ref", "--verify", "--quiet", ref])),
          ).pipe(Effect.map(Option.isNone))

        const name = Option.getOrElse(
          yield* Effect.findFirst(shortAgentNames(), free),
          uniqueAgentName,
        )

        yield* git
          .run(checkout.path, ["fetch", checkout.remote, baseBranch])
          .pipe(
            gitFailure(
              `Couldn't fetch ${baseBranch} from ${checkout.remote}. Check the branch and your connection, then try again.`,
            ),
          )

        const folder = join(
          config.dataDirectory,
          "worktrees",
          repository.owner,
          repository.repo,
          name,
        )

        yield* git
          .run(checkout.path, [
            "worktree",
            "add",
            "--no-track",
            "-b",
            name,
            folder,
            `${checkout.remote}/${baseBranch}`,
          ])
          .pipe(gitFailure(`Couldn't make a worktree for ${name}. Try again.`))

        const discard = git
          .run(checkout.path, ["worktree", "remove", "--force", folder])
          .pipe(Effect.andThen(git.run(checkout.path, ["branch", "-D", name])), Effect.ignore)

        return { name, folder, discard }
      })

      const baseRef = Effect.fn("LocalPlacement.baseRef")(function* ({ agent }: PlacedAgent) {
        const checkout = yield* checkouts
          .get(agent.repository)
          .pipe(
            Effect.catchTag("InvalidLocalCheckout", ({ message }) =>
              Effect.fail(new AgentError({ message })),
            ),
          )

        return `refs/remotes/${checkout.remote}/${agent.baseBranch}`
      })

      const worktreeExists = ({ folder }: PlacedAgent) =>
        fs.exists(folder).pipe(Effect.orElseSucceed(() => false))

      const remove = Effect.fn("LocalPlacement.remove")(function* (placed: PlacedAgent) {
        hosted.delete(placed.agent.id)
        const checkout = yield* checkouts.get(placed.agent.repository).pipe(Effect.option)

        const cwd = Option.match(checkout, {
          onSome: ({ path }) => path,
          onNone: () => placed.folder,
        })

        yield* (
          (yield* worktreeExists(placed))
            ? git.run(cwd, ["worktree", "remove", "--force", placed.folder])
            : git.run(cwd, ["worktree", "prune"]).pipe(Effect.ignore)
        ).pipe(gitFailure(`Couldn't remove ${placed.agent.name}'s worktree. Try again.`))
      })

      return LocalPlacement.of({
        engines: AgentEngine.literals,
        models: (engine) =>
          host.client.pipe(
            Effect.flatMap((client) => client.ListModels({ engine })),
            Effect.mapError(asAgentError),
          ),
        commands: Effect.fnUntraced(function* (engine, repository) {
          const { path } = yield* checkouts.get(repository)

          return yield* host.client.pipe(
            Effect.flatMap((client) => client.ListCommands({ engine, folder: path })),
            Effect.mapError(asAgentError),
          )
        }),
        defaultBranch: (repository) =>
          checkouts.branches(repository).pipe(Effect.map(({ defaultBranch }) => defaultBranch)),
        branches: (repository) =>
          checkouts.branches(repository).pipe(Effect.map(({ branches }) => branches)),
        files: Effect.fnUntraced(function* (repository, baseBranch) {
          const { path, remote } = yield* checkouts.get(repository)

          const listed = yield* git
            .runUntrimmed(path, ["ls-tree", "-r", "-z", "--name-only", `${remote}/${baseBranch}`])
            .pipe(gitFailure(`Couldn't list the files on ${baseBranch}. Try again.`))

          return listed.split("\0").filter((file) => file !== "")
        }),
        place,
        host: ({ agent }) =>
          host.client.pipe(Effect.tap(() => Effect.sync(() => void hosted.add(agent.id)))),
        runningHost: () => host.running,
        hostOnceMade: (placed) =>
          worktreeExists(placed).pipe(
            Effect.flatMap((exists) =>
              exists ? host.client.pipe(Effect.map(Option.some)) : Effect.succeedNone,
            ),
          ),
        baseRef,
        remove,
        subscribeLost: host.subscribeStopped.pipe(Effect.map(Stream.map(() => [...hosted]))),
      })
    }),
  )
}
