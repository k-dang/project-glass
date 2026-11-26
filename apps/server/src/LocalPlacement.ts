import { AgentHarness, ThreadError, type FollowedRepository } from "@glass/contracts"
import { Context, Effect, FileSystem, Layer, Option, Stream } from "effect"
import { join } from "node:path"
import { placeholderBranch } from "./BranchNames"
import { Git, type GitFailed } from "./git"
import { type CarriedOn, LocalAgentHost } from "./LocalAgentHost"
import { LocalCheckouts } from "./LocalCheckouts"
import { asThreadError, type Placement, type PlacedThread, type SubscribeLost } from "./Placement"
import { ServerConfig } from "./ServerConfig"

const gitFailure =
  (message: string) =>
  <A, R>(effect: Effect.Effect<A, GitFailed, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(message, cause)),
      Effect.mapError(() => new ThreadError({ message })),
    )

export class LocalPlacement extends Context.Service<
  LocalPlacement,
  Placement & {
    readonly subscribeLost: SubscribeLost
    readonly resume: Effect.Effect<CarriedOn>
  }
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
        const name = placeholderBranch()

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
          .pipe(
            Effect.andThen(git.run(checkout.path, ["update-ref", "-d", `refs/heads/${name}`])),
            Effect.ignore,
          )

        return { branch: name, folder, discard }
      })

      const checkoutOf = (repository: FollowedRepository) =>
        checkouts
          .get(repository)
          .pipe(
            Effect.catchTag("InvalidLocalCheckout", ({ message }) =>
              Effect.fail(new ThreadError({ message })),
            ),
          )

      const takenBranches = Effect.fn("LocalPlacement.takenBranches")(function* (
        repository: FollowedRepository,
        prefix: string,
      ) {
        const checkout = yield* checkoutOf(repository)
        const pattern = `refs/heads/${prefix}*`

        const [local, remote] = yield* Effect.all(
          [
            git.run(checkout.path, ["for-each-ref", "--format=%(refname)", pattern]),
            git.run(checkout.path, ["ls-remote", "--heads", checkout.remote, pattern]),
          ],
          { concurrency: "unbounded" },
        ).pipe(gitFailure(`Couldn't check whether ${prefix} is taken.`))

        return `${local}\n${remote}`.split("\n").map((line) => line.replace(/^.*refs\/heads\//, ""))
      })

      // WARNING: `git branch -m` and `branch -D` rewrite .git/config, which fails on Windows while any other git process reads it.
      const useBranch = Effect.fn("LocalPlacement.useBranch")(function* (
        { thread, folder }: PlacedThread,
        branch: string,
      ) {
        yield* git
          .run(folder, ["switch", "--no-track", "-c", branch])
          .pipe(gitFailure(`Couldn't rename the Thread's branch to ${branch}.`))

        if (thread.branch === null) return

        yield* git.run(folder, ["update-ref", "-d", `refs/heads/${thread.branch}`]).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning(`Couldn't delete the placeholder branch ${thread.branch}`, cause),
          ),
          Effect.ignore,
        )
      })

      const baseRef = Effect.fn("LocalPlacement.baseRef")(function* ({ thread }: PlacedThread) {
        const checkout = yield* checkoutOf(thread.repository)

        return `refs/remotes/${checkout.remote}/${thread.baseBranch}`
      })

      const worktreeExists = ({ folder }: PlacedThread) =>
        fs.exists(folder).pipe(Effect.orElseSucceed(() => false))

      const remove = Effect.fn("LocalPlacement.remove")(function* (placed: PlacedThread) {
        hosted.delete(placed.thread.id)
        const checkout = yield* checkouts.get(placed.thread.repository).pipe(Effect.option)

        const cwd = Option.match(checkout, {
          onSome: ({ path }) => path,
          onNone: () => placed.folder,
        })

        yield* (
          (yield* worktreeExists(placed))
            ? git.run(cwd, ["worktree", "remove", "--force", placed.folder])
            : git.run(cwd, ["worktree", "prune"]).pipe(Effect.ignore)
        ).pipe(gitFailure(`Couldn't remove ${placed.thread.name}'s worktree. Try again.`))
      })

      return LocalPlacement.of({
        harnesses: AgentHarness.literals,
        models: (harness) =>
          host.client.pipe(
            Effect.flatMap((client) => client.ListModels({ harness })),
            Effect.mapError(asThreadError),
          ),
        commands: Effect.fnUntraced(function* (harness, repository) {
          const { path } = yield* checkouts.get(repository)

          return yield* host.client.pipe(
            Effect.flatMap((client) => client.ListCommands({ harness, folder: path, skills: [] })),
            Effect.mapError(asThreadError),
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
        takenBranches,
        useBranch,
        prepareHost: ({ thread }) =>
          host.client.pipe(Effect.tap(() => Effect.sync(() => void hosted.add(thread.id)))),
        connectedHost: () => host.running,
        hostIfPrepared: (placed) =>
          worktreeExists(placed).pipe(
            Effect.flatMap((exists) =>
              exists ? host.client.pipe(Effect.map(Option.some)) : Effect.succeedNone,
            ),
          ),
        baseRef,
        remove,
        subscribeLost: host.subscribeStopped.pipe(Effect.map(Stream.map(() => [...hosted]))),
        resume: host.resume.pipe(
          Effect.map(({ carriedOn }) => {
            for (const threadId of carriedOn) hosted.add(threadId)

            return carriedOn
          }),
        ),
      })
    }),
  )
}
