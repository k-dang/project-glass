import { GlassRpcs, PullRequestRef } from "@glass/contracts"
import { Option, Schema } from "effect"
import { expect, it } from "vite-plus/test"

it("validates structured PR references at the OpenPullRequest RPC", () => {
  const rpc = GlassRpcs.requests.get("OpenPullRequest")!

  const decode = Schema.decodeUnknownOption(rpc.payloadSchema)
  const reference = { owner: "octo-org", repo: "Hello.World_repo", number: 2147483647 }

  expect(Option.getOrThrow(decode({ pullRequest: reference }))).toMatchObject({
    pullRequest: new PullRequestRef(reference),
  })

  for (const invalid of [
    { owner: "" },
    { owner: "bad/name" },
    { owner: "bad_name" },
    { repo: "" },
    { repo: "bad/name" },
    { number: 0 },
    { number: -1 },
    { number: 1.5 },
    { number: 2147483648 },
    { number: "7" },
  ]) {
    expect(Option.isNone(decode({ pullRequest: { ...reference, ...invalid } }))).toBe(true)
  }
})
