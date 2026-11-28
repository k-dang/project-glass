import { existsSync } from "node:fs"
import { join } from "node:path"
import { globalChatReply } from "../../server/test/fakeGlobalChat"
import { seedClone } from "../../server/test/gitRepositories"
import { expect, openPullRequest, test } from "./glass"

test.use({ piModel: { reply: globalChatReply } })

test("keeps one Global chat over every area, answered by pi without a Local checkout", async ({
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

  await window.getByRole("button", { name: "Global chat" }).click()
  const chat = window.getByRole("dialog", { name: "Global chat" })
  const message = chat.getByRole("textbox", { name: "Message" })
  await message.fill("Hello there")
  await message.press("Enter")

  await expect(chat.getByText("Fake reply to: Hello there")).toBeVisible()
  await expect(chat).toContainText(/Done in/)

  await chat.getByRole("button", { name: "Close the Global chat" }).click()
  await expect(chat).toBeHidden()
  await expect(heading).toBeVisible()

  await window.getByRole("link", { name: "Threads" }).click()
  await window.keyboard.press("ControlOrMeta+j")
  await expect(chat.getByText("Fake reply to: Hello there")).toBeVisible()
  await expect(
    window.getByRole("navigation", { name: "Threads list" }).getByRole("link"),
  ).toHaveCount(0)
  expect(existsSync(join(home, ".project-glass", "worktrees"))).toBe(false)

  await window.keyboard.press("ControlOrMeta+j")
  await expect(chat).toBeHidden()
  await window.getByRole("link", { name: "Reviews" }).click()
  await expect(heading).toBeVisible()
  await window.keyboard.press("ControlOrMeta+j")
  await expect(chat.getByText("Fake reply to: Hello there")).toBeVisible()
})

test("restores the Global chat after Glass restarts, with its waiting Turn interrupted", async ({
  window,
  relaunch,
}) => {
  await window.getByRole("button", { name: "Global chat" }).click()
  const chat = window.getByRole("dialog", { name: "Global chat" })
  const message = chat.getByRole("textbox", { name: "Message" })
  await message.fill("Please ask me something")
  await message.press("Enter")

  await expect(chat.getByRole("group", { name: "Which files should I look at?" })).toBeVisible()

  const restarted = await relaunch()
  await restarted.getByRole("button", { name: "Global chat" }).click()
  const restored = restarted.getByRole("dialog", { name: "Global chat" })

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
  await window.getByRole("button", { name: "Global chat" }).click()
  const chat = window.getByRole("dialog", { name: "Global chat" })
  await expect(chat.getByText(`Sends with ${reference} at h1`)).toBeVisible()

  const message = chat.getByRole("textbox", { name: "Message" })
  await message.fill("Summarize this PR")
  await message.press("Enter")
  await message.press("Escape")
  await expect(chat).toBeHidden()
  await window.getByRole("link", { name: "To-dos" }).click()
  await window.getByRole("button", { name: "Global chat" }).click()

  await expect(chat.getByText("No PR or Thread in view")).toBeVisible()
  await expect(chat.getByText(`From ${reference} at h1`)).toBeVisible()
  await expect(chat.getByText("read_pull_request")).toBeVisible()
  await expect(chat.getByText(/The fake model saw: .*"title":"Greet by name"/)).toBeVisible()
  await expect(chat).toContainText(/Done in/)
})

test("starts a Thread through Glass's tools, which runs its first Turn and tells the Global chat it finished", async ({
  app,
  home,
  window,
}) => {
  const { checkout } = seedClone(home, "glass-demo", "greeter")

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [folder] })
  }, checkout)

  await window.getByRole("link", { name: "Threads" }).click()
  await window.getByRole("combobox", { name: "Repository" }).click()
  await window.getByRole("option", { name: "Choose folder…" }).click()
  await expect(
    window
      .getByRole("region", { name: "New Thread" })
      .getByRole("combobox", { name: "Base branch" }),
  ).toContainText("main")

  await window.getByRole("button", { name: "Global chat" }).click()
  const chat = window.getByRole("dialog", { name: "Global chat" })
  const message = chat.getByRole("textbox", { name: "Message" })
  await message.fill("Start a Thread in glass-demo/greeter from main: Say hello")
  await message.press("Enter")

  await expect(chat.getByText("create_thread")).toBeVisible()
  await expect(chat.getByText(/The fake model saw: .*"baseBranch":"main"/)).toBeVisible()
  await expect(chat).toContainText(/Done in/)
  await chat.getByRole("button", { name: "Close the Global chat" }).click()

  const created = window.getByRole("navigation", { name: "Threads list" }).getByRole("link")
  await expect(created).toHaveCount(1)
  await created.click()
  await expect(
    window.getByRole("region", { name: "Transcript" }).getByText("Fake reply to: Say hello"),
  ).toBeVisible()

  await window.getByRole("button", { name: "Global chat" }).click()
  await expect(chat.getByText("Update from Glass")).toBeVisible()
  await expect(chat.getByText(/: finished$/)).toBeVisible()
  await expect(
    chat.getByText("The Thread you started is done. Want me to look at what it changed?"),
  ).toBeVisible()
})
