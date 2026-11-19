import { expect, openPullRequest, test } from "./glass"

const answer = {
  markdown:
    "**The greeting changes its wording.** One line changes.\n\n## Callers expect the old word\n\nBlocking: `main.ts` matches on `world`.",
}

test.use({ git: true, piModel: { output: JSON.stringify(answer) } })

test("runs an Agent review, reads it beside the diff, and shows its opening on Overview", async ({
  github,
  window,
}) => {
  const pr = github.seedPullRequest({
    base: { sha: "b0", files: { "greet.ts": "hello\nworld\n" } },
    head: { sha: "h1", files: { "greet.ts": "hello\nthere\nworld\n" } },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 1,
        patch: "@@ -1,2 +1,3 @@\n hello\n+there\n world",
      },
    ],
  })

  await openPullRequest(window, pr)
  await window.getByRole("tab", { name: "Changes" }).click()
  await window.getByRole("button", { name: "Agent work" }).click()
  const row = window.getByRole("listitem", { name: "Agent review" })
  await row.getByRole("button", { name: "Start" }).click()

  await row.getByRole("button", { name: "Read" }).click()

  const panel = window.getByRole("complementary", { name: "Agent review" })
  await expect(panel.getByRole("heading", { name: "Callers expect the old word" })).toBeVisible()

  await window.getByRole("tab", { name: "Overview" }).click()

  const card = window
    .getByRole("tabpanel", { name: "Overview" })
    .getByRole("region", { name: "Agent review" })

  await expect(card).toContainText("The greeting changes its wording.")
  await expect(card).not.toContainText("Callers expect the old word")
})
