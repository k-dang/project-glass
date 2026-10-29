// @vitest-environment happy-dom
import { Check, PullRequest, Reviewer } from "@glass/contracts"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it } from "vite-plus/test"
import { pullRequestFields } from "../../test/workspace"
import { StatusChips } from "./PullRequestStatus"

afterEach(cleanup)

const pullRequest = (fields: Partial<PullRequest>) =>
  new PullRequest({ ...pullRequestFields, ...fields })

it("falls back to the reviewers' own states when the repository requires no reviews", () => {
  const cases = [
    [[], "No reviews"],
    [[new Reviewer({ name: "mona", state: "requested" })], "Review requested"],
    [[new Reviewer({ name: "mona", state: "approved" })], "Approved"],
    [
      [
        new Reviewer({ name: "mona", state: "approved" }),
        new Reviewer({ name: "hubot", state: "changes-requested" }),
      ],
      "Changes requested",
    ],
  ] as const

  for (const [reviewers, label] of cases) {
    render(<StatusChips pullRequest={pullRequest({ approval: null, reviewers })} />)
    expect(screen.getByText(label)).toBeDefined()
    cleanup()
  }

  render(<StatusChips pullRequest={pullRequest({ approval: "review-required", reviewers: [] })} />)
  expect(screen.getByText("Review required")).toBeDefined()
})

it("counts failing checks first and lists them ahead of the rest", async () => {
  render(
    <StatusChips
      pullRequest={pullRequest({
        checks: [
          new Check({ name: "lint", state: "passed", url: null }),
          new Check({ name: "test", state: "running", url: null }),
          new Check({ name: "build", state: "failed", url: "https://ci.test/build" }),
        ],
      })}
    />,
  )

  await userEvent.setup().click(screen.getByRole("button", { name: "1 failing" }))
  const items = within(screen.getByRole("dialog")).getAllByRole("listitem")

  expect(items.map((item) => item.textContent)).toEqual(["build", "test", "lint"])
  expect(within(items[0]!).getByRole("link").getAttribute("href")).toBe("https://ci.test/build")
})

it("shows conflicts only while the PR is open", () => {
  render(<StatusChips pullRequest={pullRequest({ mergeable: "conflicting" })} />)
  expect(screen.getByText("Conflicts")).toBeDefined()
  cleanup()

  render(<StatusChips pullRequest={pullRequest({ state: "merged", mergeable: "conflicting" })} />)
  expect(screen.queryByText("Conflicts")).toBeNull()
})
