import {
  type NoCredentials,
  type PullRequestRef,
  type Revision,
  StaleRevision,
} from "@glass/contracts"
import {
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  type PlatformError,
  Redacted,
  type Scope,
  Semaphore,
} from "effect"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { Git } from "./git"
import { gitBasicAuthorization } from "./gitEnv"
import { GitHubAuth } from "./github/GitHubAuth"
import { ServerConfig } from "./ServerConfig"
import { annotateUnit } from "./wideEvents"

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

const authenticatedEnv = (token: Redacted.Redacted) => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "http.extraHeader",
  GIT_CONFIG_VALUE_1: `Authorization: ${gitBasicAuthorization(Redacted.value(token))}`,
})

const storageFailure = <A, E, R>(effect: Effect.Effect<A, E | PlatformError.PlatformError, R>) =>
  effect.pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.logWarning("Couldn't prepare the checkout", error).pipe(
        Effect.andThen(Effect.fail(new CheckoutFailure({ reason: "storage" }))),
      ),
    ),
  )

export class Checkouts extends Context.Service<
  Checkouts,
  {
    readonly checkout: (
      pr: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<string, CheckoutFailure | StaleRevision | NoCredentials, Scope.Scope>
    readonly checkoutInto: (
      pr: PullRequestRef,
      revision: Revision,
      folder: string,
    ) => Effect.Effect<void, CheckoutFailure | StaleRevision | NoCredentials>
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

        const existing = yield* fs.exists(clone)
        yield* annotateUnit({ clone: existing ? "existing" : "new" })

        if (existing) {
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

      const fill = Effect.fnUntraced(function* (
        pr: PullRequestRef,
        revision: Revision,
        files: string,
        index: string,
      ) {
        const repository = `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}`
        const clone = join(config.dataDirectory, "repos", repository)
        const ref = `refs/pull/${pr.number}/head`

        yield* Effect.gen(function* () {
          const { token } = yield* auth.resolveToken
          const env = authenticatedEnv(token)

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

          return yield* git(
            ["--git-dir", clone, "--work-tree", files, "read-tree", "--reset", "-u", head],
            { ...env, GIT_INDEX_FILE: index },
          ).pipe(Effect.asVoid)
        }).pipe(
          Effect.timeoutOrElse({
            duration: config.checkoutTimeoutMs,
            orElse: () => Effect.fail(new CheckoutFailure({ reason: "timeout" })),
          }),
          Semaphore.withPermit(lock(repository)),
        )
      })

      const checkout = Effect.fn("Checkouts.checkout")(function* (
        pr: PullRequestRef,
        revision: Revision,
      ) {
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "glass-checkout-" })
        const files = join(directory, pr.repo)

        yield* fill(pr, revision, files, join(directory, "index"))

        return files
      }, storageFailure)

      const checkoutInto = Effect.fn("Checkouts.checkoutInto")(function* (
        pr: PullRequestRef,
        revision: Revision,
        folder: string,
      ) {
        const index = `${folder}.index`

        yield* fs.makeDirectory(dirname(folder), { recursive: true })
        yield* fill(pr, revision, folder, index).pipe(
          Effect.onError(() =>
            fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
          Effect.ensuring(fs.remove(index, { force: true }).pipe(Effect.ignore)),
        )
      }, storageFailure)

      return Checkouts.of({ checkout, checkoutInto })
    }),
  )
}
