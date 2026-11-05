import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, openPullRequest, test } from "./glass"

test("keeps one Global conversation beside every area, answered by Claude Code without a Local checkout", async ({
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
  const conversation = window.getByRole("complementary", { name: "Global conversation" })
  const message = conversation.getByRole("textbox", { name: "Message" })
  await message.fill("Hello there")
  await message.press("Enter")

  await expect(conversation.getByText("Fake reply to: Hello there")).toBeVisible()
  await expect(conversation).toContainText(/Done in/)
  await expect(heading).toBeVisible()

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

  await window.getByRole("link", { name: "Reviews" }).click()
  await expect(heading).toBeVisible()
  await expect(conversation.getByText("Fake reply to: Hello there")).toBeVisible()
})

test("restores the Global conversation after Glass restarts, with its waiting Turn interrupted", async ({
  window,
  relaunch,
}) => {
  await window.getByRole("button", { name: "Global conversation" }).click()
  const conversation = window.getByRole("complementary", { name: "Global conversation" })
  const message = conversation.getByRole("textbox", { name: "Message" })
  await message.fill("Please ask me something")
  await message.press("Enter")

  await expect(conversation.getByText("Which files should I look at?")).toBeVisible()

  const restarted = await relaunch()
  await restarted.getByRole("button", { name: "Global conversation" }).click()
  const restored = restarted.getByRole("complementary", { name: "Global conversation" })

  await expect(restored.getByText("Please ask me something")).toBeVisible()
  await expect(restored.getByText("Interrupted when Glass quit")).toBeVisible()
  await expect(restored.getByText("No longer answerable: its Turn ended.")).toBeVisible()
})
