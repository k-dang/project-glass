import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { type NoCredentials, PullRequestRef, Revision, StaleRevision } from "@glass/contracts"
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Scope,
} from "effect"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import { type FakeGitHub, startFakeGitHub } from "../test/fakeGitHub"
import { type FakePullRequest, type FakePullRequestSeed, VIEWER } from "../test/fakePullRequest"
import { isolatedHome, LAUNCH_TOKEN } from "../test/harness"
import { CheckoutFailure, Checkouts } from "./Checkouts"
import { Git } from "./git"
import { GitHubAuth } from "./github/GitHubAuth"
import { ServerConfig } from "./ServerConfig"

const reference = (pr: FakePullRequest) =>
  new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })

const revision = (pr: FakePullRequest) => new Revision({ base: pr.base.sha, head: pr.head.sha })

const fixture = Effect.fnUntraced(function* ({
  env = {},
  token = VIEWER.token,
  home: sharedHome,
}: {
  readonly env?: Record<string, string>
  readonly token?: string
  readonly home?: string
} = {}) {
  const github = yield* startFakeGitHub({ git: true })
  const home = sharedHome ?? (yield* isolatedHome)
  vi.stubEnv("HOME", home)
  vi.stubEnv("USERPROFILE", home)

  const services = yield* Layer.build(
    Checkouts.layer.pipe(
      Layer.provide(
        Layer.succeed(
          GitHubAuth,
          GitHubAuth.of({
            resolveToken: Effect.succeed({ token: Redacted.make(token), source: "GH_TOKEN" }),
          }),
        ),
      ),
      Layer.provide(Git.layer),
      Layer.provide(ServerConfig.layer),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            GLASS_PORT: "0",
            GLASS_TOKEN: LAUNCH_TOKEN,
            GLASS_HOME: home,
            GLASS_GIT_REMOTE: github.gitUrl,
            ...env,
          }),
        ),
      ),
    ),
  )

  const checkouts = Context.get(services, Checkouts)

  const checkout = (pr: FakePullRequest, requested = revision(pr)) =>
    checkouts.checkout(reference(pr), requested)

  const failure = (pr: FakePullRequest, requested = revision(pr)) =>
    Effect.flip(Effect.scoped(checkout(pr, requested)))

  return { github, home, checkout, failure }
})

const seed = (github: FakeGitHub, overrides: Partial<FakePullRequestSeed> = {}) =>
  github.seedPullRequest({
    base: { sha: "b0", files: { "greet.ts": "hello" } },
    head: { sha: "h1", files: { "greet.ts": "hello name", "docs/README.md": "greeting" } },
    ...overrides,
  })

const files = async (directory: string) =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const path = join(entry.parentPath, entry.name)

          return [
            path.slice(directory.length + 1).replaceAll("\\", "/"),
            await readFile(path, "utf8"),
          ]
        }),
    ),
  )

const assertFailure = (
  error: CheckoutFailure | StaleRevision | NoCredentials,
  reason: CheckoutFailure["reason"],
) => {
  assert.instanceOf(error, CheckoutFailure)
  assert.strictEqual(error.reason, reason)
}

const cloneOf = (home: string, pr: FakePullRequest) =>
  join(home, ".project-glass", "repos", pr.owner, pr.repo)

it.live("checks out the Revision's head into a directory removed when its scope closes", () =>
  Effect.gen(function* () {
    const { github, checkout } = yield* fixture()
    const pr = seed(github)
    const scope = yield* Scope.make()

    const directory = yield* checkout(pr).pipe(Scope.provide(scope))

    assert.deepStrictEqual(yield* Effect.promise(() => files(directory)), {
      "greet.ts": "hello name",
      "docs/README.md": "greeting",
    })

    yield* Scope.close(scope, Exit.void)
    assert.isFalse(existsSync(directory))
  }),
)

it.live("removes the checkout when its job is interrupted", () =>
  Effect.gen(function* () {
    const { github, checkout } = yield* fixture()
    const pr = seed(github)
    const checkedOut = yield* Deferred.make<string>()

    const job = yield* checkout(pr).pipe(
      Effect.flatMap((directory) => Deferred.succeed(checkedOut, directory)),
      Effect.andThen(Effect.never),
      Effect.scoped,
      Effect.forkChild,
    )

    const directory = yield* Deferred.await(checkedOut)
    yield* Fiber.interrupt(job)

    assert.isFalse(existsSync(directory))
  }),
)

it.live("clones a repository once and only fetches for later checkouts", () =>
  Effect.gen(function* () {
    const { github, home, checkout } = yield* fixture()
    const first = seed(github)
    const second = seed(github, { head: { sha: "h2", files: { "farewell.ts": "bye" } } })

    yield* Effect.scoped(checkout(first))
    const marker = join(cloneOf(home, first), "kept-by-test")
    yield* Effect.promise(() => writeFile(marker, ""))

    const directory = yield* checkout(second)

    assert.deepStrictEqual(yield* Effect.promise(() => files(directory)), { "farewell.ts": "bye" })
    assert.isTrue(existsSync(marker))
  }).pipe(Effect.scoped),
)

it.live("checks out one repository at a time and different repositories at once", () =>
  Effect.gen(function* () {
    const { github, checkout } = yield* fixture()

    const together = (prs: ReadonlyArray<FakePullRequest>) =>
      Effect.forEach(prs, (pr) => checkout(pr), {
        concurrency: "unbounded",
      }).pipe(Effect.scoped)

    github.gitTraffic.slow("20 millis")
    const sameRepository = [seed(github), seed(github, { head: { sha: "h2", files: {} } })]
    yield* together(sameRepository)
    assert.strictEqual(github.gitTraffic.mostAtOnce, 1)

    github.gitTraffic.gather(2)
    yield* together([seed(github, { repo: "first" }), seed(github, { repo: "second" })])
    assert.strictEqual(github.gitTraffic.mostAtOnce, 2)
  }),
)

it.live("authenticates git with the Connection's token without saving it", () =>
  Effect.gen(function* () {
    const { github, home, checkout } = yield* fixture()
    const pr = seed(github)

    yield* Effect.scoped(checkout(pr))

    const config = yield* Effect.promise(() => readFile(join(cloneOf(home, pr), "config"), "utf8"))
    assert.notInclude(config, VIEWER.token)
    assert.isFalse(existsSync(join(home, ".gitconfig")))
  }),
)

it.live("ignores git settings inherited from the backend's environment", () =>
  Effect.gen(function* () {
    const { github, checkout } = yield* fixture()
    const pr = seed(github)
    vi.stubEnv("GIT_CONFIG_PARAMETERS", `'url.http://127.0.0.1:9/.insteadof'='${github.gitUrl}/'`)

    const directory = yield* checkout(pr)

    assert.isTrue(existsSync(join(directory, "greet.ts")))
  }).pipe(Effect.scoped),
)

it.live("fetches from the configured remote after it changes", () =>
  Effect.gen(function* () {
    const before = yield* fixture()
    yield* Effect.scoped(before.checkout(seed(before.github)))

    const after = yield* fixture({ home: before.home })
    const pr = seed(after.github)
    before.github.unavailableRepositories.add(`${pr.owner}/${pr.repo}`)

    const directory = yield* after.checkout(pr)

    assert.isTrue(existsSync(join(directory, "greet.ts")))
  }).pipe(Effect.scoped),
)

it.live("fails as storage when Glass can't write its clones", () =>
  Effect.gen(function* () {
    const { github, home, failure } = yield* fixture()
    yield* Effect.promise(() => mkdir(join(home, ".project-glass"), { recursive: true }))
    yield* Effect.promise(() => writeFile(join(home, ".project-glass", "repos"), ""))

    assertFailure(yield* failure(seed(github)), "storage")
  }),
)

it.live("fails as refused access when GitHub refuses the token", () =>
  Effect.gen(function* () {
    const { github, failure } = yield* fixture({ token: "revoked-token" })
    const pr = seed(github)

    const error = yield* failure(pr)

    assertFailure(error, "access-refused")
  }),
)

it.live("fails as a stale Revision when the PR's head has moved on", () =>
  Effect.gen(function* () {
    const { github, failure } = yield* fixture()
    const pr = seed(github)
    const requested = revision(pr)
    pr.push({ head: { sha: "h2", files: { "greet.ts": "hi name" } } })

    const error = yield* failure(pr, requested)

    assert.instanceOf(error, StaleRevision)
  }),
)

it.live("fails as unreachable when the repository can't be found", () =>
  Effect.gen(function* () {
    const { github, failure } = yield* fixture()
    const pr = seed(github)
    github.unavailableRepositories.add(`${pr.owner}/${pr.repo}`)

    const error = yield* failure(pr)

    assertFailure(error, "unreachable")
  }),
)

it.live("fails as a failed fetch when GitHub errors", () =>
  Effect.gen(function* () {
    const { github, failure } = yield* fixture()
    const pr = seed(github)
    github.failNext(500)

    const error = yield* failure(pr)

    assertFailure(error, "fetch-failed")
  }),
)

it.live("times out a slow fetch and checks out once it recovers", () =>
  Effect.gen(function* () {
    const { github, checkout, failure } = yield* fixture({
      env: { GLASS_CHECKOUT_TIMEOUT_MS: "1000" },
    })

    const pr = seed(github)

    yield* Effect.scoped(checkout(pr))
    github.timingOutRepositories.add(`${pr.owner}/${pr.repo}`)
    assertFailure(yield* failure(pr), "timeout")

    github.timingOutRepositories.clear()
    yield* Effect.scoped(checkout(pr))
  }),
)
