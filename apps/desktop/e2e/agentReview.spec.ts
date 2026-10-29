import { expect, openPullRequest, test } from "./glass"

test.use({ git: true })

test("runs an Agent review, reads it beside the diff, and shows its opening on Overview", async ({
  github,
  piCli,
  window,
}) => {
  await piCli.answer({
    markdown:
      "**The greeting changes its wording.** One line changes.\n\n## Callers expect the old word\n\nBlocking: `main.ts` matches on `world`.",
  })

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
  const changes = window.getByRole("tabpanel", { name: "Changes" })
  await changes.getByRole("button", { name: "Agent review" }).click()

  await expect(changes.getByRole("status", { name: "Agent review" })).toHaveText(
    "Agent review written·Read beside the diff",
  )
  await changes.getByRole("button", { name: "Read beside the diff" }).click()

  await expect(window.getByRole("tab", { name: "Agent review" })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  const panel = window.getByRole("region", { name: "Agent review" })
  await expect(panel.getByRole("heading", { name: "Callers expect the old word" })).toBeVisible()

  await window.getByRole("tab", { name: "Overview" }).click()

  const card = window
    .getByRole("tabpanel", { name: "Overview" })
    .getByRole("region", { name: "Agent review" })

  await expect(card).toContainText("The greeting changes its wording.")
  await expect(card).not.toContainText("Callers expect the old word")
})
