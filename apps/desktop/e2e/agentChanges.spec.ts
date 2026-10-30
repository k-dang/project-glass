import { join } from "node:path"
import { runCommands } from "../../server/test/fakeModelProvider"
import { seedClone } from "../../server/test/gitRepositories"
import { expect, test } from "./glass"

const agentTurnTimeout = 20_000

test.use({
  realPiModel: {
    reply: runCommands({
      "Write a note": "printf 'hello from the Agent\\n' > notes.txt",
      "Write another": "printf 'a second note\\n' > more.txt",
    }),
  },
})

test("reviews a local Agent's changes on its Changes tab, held still until moved to the latest", async ({
  app,
  home,
  window,
}) => {
  const { checkout } = seedClone(join(home, "repositories"), "glass-demo", "greeter")

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, checkout)

  await window.getByRole("link", { name: "Agents" }).click()
  await window.getByRole("combobox", { name: "Repository" }).click()
  await window.getByRole("option", { name: "Choose folder…" }).click()
  await expect(window.getByRole("combobox", { name: "Base branch" })).toContainText("main")
  await window.getByRole("button", { name: /^Claude Code:/ }).click()
  await window
    .getByRole("group", { name: "Agent program" })
    .getByRole("button", { name: "pi" })
    .click()
  await window.keyboard.press("Escape")
  await expect(window.getByRole("button", { name: /^pi:/ })).toBeVisible()
  const message = window.getByRole("textbox", { name: "Message" })
  await message.fill("Write a note")
  await message.press("Enter")
  await expect(window.getByText(/^Done in/)).toBeVisible({ timeout: agentTurnTimeout })

  await window.getByRole("tab", { name: "Changes" }).click()
  const changes = window.getByRole("tabpanel", { name: "Changes" })
  await expect(changes.getByText("hello from the Agent")).toBeVisible()
  await expect(message).toBeHidden()

  await window.getByRole("tab", { name: "Chat" }).click()
  await message.fill("Write another")
  await message.press("Enter")
  await expect(window.getByText(/^Done in/)).toHaveCount(2, { timeout: agentTurnTimeout })

  await window.getByRole("tab", { name: "Changes" }).click()
  await expect(changes.getByRole("note")).toContainText("worked since you opened these changes")
  await expect(changes.getByText("a second note")).toHaveCount(0)

  await changes.getByRole("button", { name: "Show latest" }).click()
  await expect(changes.getByText("a second note")).toBeVisible()
  await expect(changes.getByText("hello from the Agent")).toBeVisible()
})
