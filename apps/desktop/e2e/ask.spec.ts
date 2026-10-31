import { expect, openPullRequest, startLineDraft, test } from "./glass"

test.use({ git: true })

test("turns a new Draft into a question about its line and reads the private answer under it", async ({
  github,
  piCli,
  window,
}) => {
  await piCli.answer({ answer: "`main.ts` prints `there` after the greeting." })

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
  await startLineDraft(changes, "there")
  await changes.getByRole("textbox", { name: "Draft on greet.ts line +2" }).fill("Who prints this?")
  await changes.getByRole("button", { name: "Ask the agent about greet.ts line +2" }).click()

  const note = changes.getByRole("region", { name: "Ask on greet.ts line +2" })
  await expect(note).toContainText("main.ts prints there after the greeting.")
  await expect(note).toContainText("Only you can see this")
  await expect(note).toContainText("pi · anthropic/claude-sonnet-5-5")
  await expect(changes.getByRole("textbox", { name: /^Draft on / })).toHaveCount(0)
  expect(pr.pendingReview).toBeUndefined()

  await window.getByRole("link", { name: "Activity" }).click()
  await window.goBack()
  await expect(note).toContainText("main.ts prints there after the greeting.")

  await note.getByRole("button", { name: "Dismiss answer on greet.ts line +2" }).click()
  await expect(note).toHaveCount(0)
})
