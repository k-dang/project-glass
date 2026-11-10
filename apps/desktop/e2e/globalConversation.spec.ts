import { existsSync } from "node:fs"
import { join } from "node:path"
import { globalConversationReply } from "../../server/test/fakeGlobalConversation"
import { seedClone } from "../../server/test/gitRepositories"
import { expect, openPullRequest, test } from "./glass"

test.use({ piModel: { reply: globalConversationReply } })

test("keeps one Global conversation over every area, answered by pi without a Local checkout", async ({
  github,
  home,
  window,
}) => {
  const pr = github.seedPullRequest({
    base: { sha: "b0", files: {} },
    head: { sha: "h1", files: {} },
  })

  await openPullRequest(window, pr)
  const heading = window.getByRole("heading", { name: `${pr.title} #${pr.number}` })

  await window.getByRole("button", { name: "Global conversation" }).click()
  const conversation = window.getByRole("dialog", { name: "Global conversation" })
  const message = conversation.getByRole("textbox", { name: "Message" })
  await message.fill("Hello there")
  await message.press("Enter")

  await expect(conversation.getByText("Fake reply to: Hello there")).toBeVisible()
  await expect(conversation).toContainText(/Done in/)

  await conversation.getByRole("button", { name: "Close the Global conversation" }).click()
  await expect(conversation).toBeHidden()
  await expect(heading).toBeVisible()

  await window.getByRole("link", { name: "Agents" }).click()
  await window.keyboard.press("ControlOrMeta+j")
  await expect(conversation.getByText("Fake reply to: Hello there")).toBeVisible()
  await expect(
    window.getByRole("navigation", { name: "Agents list" }).getByRole("link"),
  ).toHaveCount(0)
  expect(existsSync(join(home, ".project-glass", "worktrees"))).toBe(false)

  await window.keyboard.press("ControlOrMeta+j")
  await expect(conversation).toBeHidden()
  await window.getByRole("link", { name: "Reviews" }).click()
  await expect(heading).toBeVisible()
  await window.keyboard.press("ControlOrMeta+j")
  await expect(conversation.getByText("Fake reply to: Hello there")).toBeVisible()
})

test("restores the Global conversation after Glass restarts, with its waiting Turn interrupted", async ({
  window,
  relaunch,
}) => {
  await window.getByRole("button", { name: "Global conversation" }).click()
  const conversation = window.getByRole("dialog", { name: "Global conversation" })
  const message = conversation.getByRole("textbox", { name: "Message" })
  await message.fill("Please ask me something")
  await message.press("Enter")

  await expect(
    conversation.getByRole("group", { name: "Which files should I look at?" }),
  ).toBeVisible()

  const restarted = await relaunch()
  await restarted.getByRole("button", { name: "Global conversation" }).click()
  const restored = restarted.getByRole("dialog", { name: "Global conversation" })

  await expect(restored.getByText("Please ask me something")).toBeVisible()
  await expect(restored.getByText("Interrupted when Glass quit")).toBeVisible()
  await expect(restored.getByText("No longer answerable: its Turn ended.")).toBeVisible()
})

test("reads the PR in view through Glass's tools, keeping that PR after navigating away", async ({
  github,
  window,
}) => {
  const pr = github.seedPullRequest({
    title: "Greet by name",
    base: { sha: "b0", files: { "greet.ts": "hi\n" } },
    head: { sha: "h1", files: { "greet.ts": "hello name\n" } },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-hi\n+hello name",
      },
    ],
  })

  const reference = `${pr.owner}/${pr.repo}#${pr.number}`

  await openPullRequest(window, pr)
  await window.getByRole("button", { name: "Global conversation" }).click()
  const conversation = window.getByRole("dialog", { name: "Global conversation" })
  await expect(conversation.getByText(`Sends with ${reference} at h1`)).toBeVisible()

  const message = conversation.getByRole("textbox", { name: "Message" })
  await message.fill("Summarize this PR")
  await message.press("Enter")
  await message.press("Escape")
  await expect(conversation).toBeHidden()
  await window.getByRole("link", { name: "To-dos" }).click()
  await window.getByRole("button", { name: "Global conversation" }).click()

  await expect(conversation.getByText("No PR or Agent in view")).toBeVisible()
  await expect(conversation.getByText(`From ${reference} at h1`)).toBeVisible()
  await expect(conversation.getByText("read_pull_request")).toBeVisible()
  await expect(
    conversation.getByText(/The fake model saw: .*"title":"Greet by name"/),
  ).toBeVisible()
  await expect(conversation).toContainText(/Done in/)
})

test("starts an Agent through Glass's tools, which appears in Agents and runs its first Turn", async ({
  app,
  home,
  window,
}) => {
  const { checkout } = seedClone(home, "glass-demo", "greeter")

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] })
  }, checkout)

  await window.getByRole("link", { name: "Agents" }).click()
  await window.getByRole("combobox", { name: "Repository" }).click()
  await window.getByRole("option", { name: "Choose folder…" }).click()
  await expect(
    window
      .getByRole("region", { name: "New Agent" })
      .getByRole("combobox", { name: "Base branch" }),
  ).toContainText("main")

  await window.getByRole("button", { name: "Global conversation" }).click()
  const conversation = window.getByRole("dialog", { name: "Global conversation" })
  const message = conversation.getByRole("textbox", { name: "Message" })
  await message.fill("Start an Agent in glass-demo/greeter from main: Say hello")
  await message.press("Enter")

  await expect(conversation.getByText("create_agent")).toBeVisible()
  await expect(conversation.getByText(/The fake model saw: .*"baseBranch":"main"/)).toBeVisible()
  await expect(conversation).toContainText(/Done in/)
  await conversation.getByRole("button", { name: "Close the Global conversation" }).click()

  const created = window.getByRole("navigation", { name: "Agents list" }).getByRole("link")
  await expect(created).toHaveCount(1)
  await created.click()
  await expect(
    window.getByRole("region", { name: "Transcript" }).getByText("Fake reply to: Say hello"),
  ).toBeVisible()
})
