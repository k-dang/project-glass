import { parsePullRequestReference, PullRequestRef } from "@glass/contracts"
import { expect, it } from "vite-plus/test"

it("parses GitHub PR URLs and repository-qualified references", () => {
  const reference = new PullRequestRef({ owner: "octo-org", repo: "hello-world", number: 7 })

  for (const input of [
    "https://github.com/octo-org/hello-world/pull/7",
    "  https://github.com/octo-org/hello-world/pull/7/  ",
    "https://github.com/octo-org/hello-world/pull/7/files?w=1#diff-abc",
    "https://www.github.com/octo-org/hello-world/pull/7/commits",
    "github.com/octo-org/hello-world/pull/7",
    "  octo-org/hello-world#7  ",
  ]) {
    expect(parsePullRequestReference(input)).toEqual(reference)
  }

  expect(parsePullRequestReference("OCTO-ORG/Hello.World_repo#2147483647")).toEqual(
    new PullRequestRef({ owner: "OCTO-ORG", repo: "Hello.World_repo", number: 2147483647 }),
  )
})

it("rejects incomplete references, other hosts, and invalid PR numbers", () => {
  for (const input of [
    "",
    "not a url",
    "#7",
    "hello-world#7",
    "https://gitlab.com/octo-org/hello-world/pull/7",
    "https://notgithub.com/octo-org/hello-world/pull/7",
    "https://example.com/github.com/octo-org/hello-world/pull/7",
    "https://github.com/octo-org/hello-world/pull/7garbage",
    "https://github.com/octo-org/hello-world/issues/7",
    "https://github.com/octo-org/hello-world/pull/0",
    "https://github.com/octo-org/hello-world/pull/seven",
    "https://github.com/octo-org/hello-world/pull/2147483648",
    "https://github.com/octo-org/pull/7",
    "octo-org/hello-world#0",
    "octo-org/hello-world#2147483648",
    "octo-org/hello-world#7.5",
  ]) {
    expect(parsePullRequestReference(input)).toBeNull()
  }
})
