import {
  type NoCredentials,
  type PullRequestRef,
  type Revision,
  StaleRevision,
} from "@glass/contracts"
import { Context, Data, Effect, FileSystem, Layer, Redacted, type Scope, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { Git } from "./git"
import { basicAuthorization } from "./gitEnv"
import { GitHubAuth } from "./github/GitHubAuth"
import { ServerConfig } from "./ServerConfig"

export class CheckoutFailure extends Data.TaggedError("CheckoutFailure")<{
  readonly reason: "unreachable" | "access-refused" | "fetch-failed" | "timeout" | "storage"
}> {}

const failureReason = (output: string): CheckoutFailure["reason"] => {
  if (/could not read Username|Authentication failed|returned error: 40[13]/i.test(output))
    return "access-refused"

  if (/repository '.*' not found|Could not resolve host|Failed to connect/i.test(output))
    return "unreachable"

  return "fetch-failed"
}

/** Sends the token with each request of one git command, without git saving it anywhere. */
const authenticatedEnv = (token: Redacted.Redacted) => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "http.extraHeader",
  GIT_CONFIG_VALUE_1: `Authorization: ${basicAuthorization(Redacted.value(token))}`,
})

export class Checkouts extends Context.Service<
  Checkouts,
  {
    readonly checkout: (
      pr: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<string, CheckoutFailure | StaleRevision | NoCredentials, Scope.Scope>
  }
>()("@glass/server/Checkouts") {
  static readonly layer = Layer.effect(
    Checkouts,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const auth = yield* GitHubAuth
      const fs = yield* FileSystem.FileSystem
      const gitService = yield* Git
      const locks = new Map<string, Semaphore.Semaphore>()

      const lock = (key: string) => {
        const existing = locks.get(key)

        if (existing !== undefined) return existing

        const created = Semaphore.makeUnsafe(1)
        locks.set(key, created)

        return created
      }

      const git = (args: ReadonlyArray<string>, env: Record<string, string>) =>
        gitService.isolated(args, env).pipe(
          Effect.tapError(({ stderr }) =>
            Effect.logWarning(`git ${args.join(" ")} failed`, stderr),
          ),
          Effect.mapError(
            ({ code, stderr }) =>
              new CheckoutFailure({
                reason: code === null ? "fetch-failed" : failureReason(stderr),
              }),
          ),
        )

      /** Holding the clone's lock means no git runs on it, so any lock file is a killed git's. */
      const removeStaleLockFiles = Effect.fnUntraced(function* (clone: string) {
        const top = yield* fs.readDirectory(clone)
        const refs = yield* fs.readDirectory(join(clone, "refs"), { recursive: true })
        const paths = [...top, ...refs.map((path) => join("refs", path))]

        for (const lockFile of paths.filter((path) => path.endsWith(".lock"))) {
          yield* fs.remove(join(clone, lockFile))
        }
      })

      const ensureClone = Effect.fnUntraced(function* (
        repository: string,
        clone: string,
        env: Record<string, string>,
      ) {
        const url = `${config.gitRemote}/${repository}.git`

        if (yield* fs.exists(clone)) {
          yield* removeStaleLockFiles(clone)
          yield* git(["--git-dir", clone, "remote", "set-url", "origin", url], env)

          return
        }

        const partial = `${clone}.${randomUUID()}.partial`
        yield* fs.makeDirectory(dirname(clone), { recursive: true })

        yield* git(
          ["clone", "--bare", "--filter=blob:none", "--no-tags", "--quiet", url, partial],
          env,
        ).pipe(
          Effect.andThen(fs.rename(partial, clone)),
          Effect.ensuring(fs.remove(partial, { recursive: true, force: true }).pipe(Effect.ignore)),
        )
      })

      const checkout = Effect.fn("Checkouts.checkout")(
        function* (pr: PullRequestRef, revision: Revision) {
          const { token } = yield* auth.resolveToken
          const env = authenticatedEnv(token)
          const repository = `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}`
          const clone = join(config.dataDirectory, "repos", repository)
          const ref = `refs/pull/${pr.number}/head`
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "glass-checkout-" })
          const files = join(directory, pr.repo)

          return yield* Effect.gen(function* () {
            yield* ensureClone(repository, clone, env)
            yield* git(
              ["--git-dir", clone, "fetch", "--quiet", "--no-tags", "origin", `+${ref}:${ref}`],
              env,
            )

            const head = yield* git(
              ["--git-dir", clone, "rev-parse", "--verify", `${ref}^{commit}`],
              env,
            )

            if (head !== revision.head) return yield* new StaleRevision()

            yield* fs.makeDirectory(files)

            yield* git(
              ["--git-dir", clone, "--work-tree", files, "read-tree", "--reset", "-u", head],
              {
                ...env,
                GIT_INDEX_FILE: join(directory, "index"),
              },
            )

            return files
          }).pipe(
            Effect.timeoutOrElse({
              duration: config.checkoutTimeoutMs,
              orElse: () => Effect.fail(new CheckoutFailure({ reason: "timeout" })),
            }),
            Semaphore.withPermit(lock(repository)),
          )
        },
        Effect.catchTag("PlatformError", (error) =>
          Effect.logWarning("Couldn't prepare the checkout", error).pipe(
            Effect.andThen(Effect.fail(new CheckoutFailure({ reason: "storage" }))),
          ),
        ),
      )

      return Checkouts.of({ checkout })
    }),
  )
}
