import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeClaude } from "../../server/test/fakeClaude"
import { seedClone } from "../../server/test/gitRepositories"
import { expect, test as glass } from "./glass"

// Agents drive `claude` through the Claude Agent SDK, so this file swaps the Tours' fake for one
// that speaks the SDK's protocol.
const test = glass.extend({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from it.
  claude: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "glass-e2e-claude-agent-"))

    const { command } = await Effect.runPromise(
      fakeClaude(directory, {
        reply: [
          {
            toolCall: { id: "bash-1", name: "Bash", input: { command: "ls" }, output: "README.md" },
          },
          { text: "It holds a README." },
        ],
      }),
    )

    await use({
      command,
      answer: () => Promise.reject(new Error("This file writes no Tours.")),
    })
    await rm(directory, { recursive: true, force: true })
  },
})

test("starts a local Claude Code Agent and answers its Permission request", async ({
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

  const draft = window.getByRole("region", { name: "New Agent" })
  await expect(draft.getByRole("combobox", { name: "Permission mode" })).toContainText("Default")
  await expect(draft.getByRole("combobox", { name: "Base branch" })).toContainText("main")
  await draft.getByRole("textbox", { name: "Message" }).fill("What's here?")
  await draft.getByRole("textbox", { name: "Message" }).press("Enter")

  const card = window.getByRole("region", { name: "Allow Bash?" })
  await expect(card).toContainText('"command": "ls"')
  await expect(
    window
      .getByRole("navigation", { name: "Agents list" })
      .getByRole("link", { description: /Waiting on you/ }),
  ).toHaveCount(1)
  await expect(window.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "placeholder",
    "Answer the Permission request above first",
  )

  await card.getByRole("button", { name: "Allow" }).click()

  const transcript = window.getByRole("region", { name: "Transcript" })
  await expect(transcript).toContainText("It holds a README.")
  await expect(transcript).toContainText(/Done in/)
  await expect(card).toContainText("Allowed")
  await expect(window.getByText("Waiting on you")).toHaveCount(0)
})
