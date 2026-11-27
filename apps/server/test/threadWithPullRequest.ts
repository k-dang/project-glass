import { Effect, Stream } from "effect"
import type { FakePullRequestSeed } from "./fakePullRequest"
import { gitIn } from "./gitRepositories"
import { holding, settled, threadsFixture } from "./threadsFixture"

export const greeterPullRequest = (number: number, headBranch: string) => ({
  owner: "glass-demo",
  repo: "greeter",
  number,
  headBranch,
  base: { sha: "b0", files: {} },
  head: { sha: `h${number}`, files: {} },
})

type Fixture = Effect.Success<typeof threadsFixture>

export const pullRequestFor = Effect.fnUntraced(function* (
  f: Fixture,
  number: number,
  harness?: Parameters<Fixture["start"]>[1],
  seed: Partial<FakePullRequestSeed> = {},
) {
  const gate = `open-${number}`
  const headBranch = `feature/own-${number}`
  const thread = yield* f.start(`hold:${gate}`, harness)
  yield* f.transcript(thread.id, holding)
  gitIn(f.worktree(thread.name), "switch", "--quiet", "-c", headBranch)

  const pullRequest = f.github.seedPullRequest({
    ...greeterPullRequest(number, headBranch),
    ...seed,
  })

  yield* f.release(gate)
  yield* f.transcript(thread.id, settled(1))

  yield* f.client.WatchThreadPullRequests().pipe(
    Stream.filter((listed) => listed.some(({ threadId }) => threadId === thread.id)),
    Stream.runHead,
  )

  return { thread, pullRequest }
})

export const threadWithPullRequest = Effect.gen(function* () {
  const f = yield* threadsFixture
  yield* f.client.FollowRepository({ input: "glass-demo/greeter" })

  return { ...f, ...(yield* pullRequestFor(f, 7)) }
})
