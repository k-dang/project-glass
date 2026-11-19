import { VIEWER } from "../../server/test/fakePullRequest"
import { expect, openPullRequest, startLineDraft, test } from "./glass"

const patch = "@@ -1,2 +1,3 @@\n hello\n+there\n world"

test("approves a PR with a Draft written on a diff line", async ({ github, window }) => {
  const pr = github.seedPullRequest({
    base: { sha: "b0", files: { "greet.ts": "hello\nworld\n" } },
    head: { sha: "h1", files: { "greet.ts": "hello\nthere\nworld\n" } },
    changedFiles: [{ path: "greet.ts", status: "modified", additions: 1, patch }],
  })

  await openPullRequest(window, pr)

  await window.getByRole("tab", { name: "Changes" }).click()
  const changes = window.getByRole("tabpanel", { name: "Changes" })
  await startLineDraft(changes, "there")
  const draft = changes.getByRole("textbox", { name: "Draft on greet.ts line +2" })
  await draft.fill("Why there?")
  await draft.press("Enter")
  await expect(changes.getByText("Saved privately")).toBeVisible()

  await window.getByRole("button", { name: /^Finish Review/ }).click()
  const finish = window.getByRole("dialog", { name: "Finish your Review" })
  await finish.getByRole("radio", { name: "Approve" }).check()
  await finish.getByRole("button", { name: "Submit Review" }).click()
  await expect(window.getByText("Review submitted")).toBeVisible()

  expect(pr.pendingReview).toBeUndefined()
  expect(pr.reviews.map(({ author, state }) => ({ author, state }))).toEqual([
    { author: VIEWER.login, state: "APPROVED" },
  ])
  expect(
    pr.reviewThreads.map(({ path, line, comments }) => ({
      path,
      line,
      bodies: comments.map(({ bodyHtml }) => bodyHtml),
    })),
  ).toEqual([{ path: "greet.ts", line: 2, bodies: ["<p>Why there?</p>"] }])
})
