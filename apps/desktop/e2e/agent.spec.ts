import { seedClone } from "../../server/test/gitRepositories"
import { expect, test } from "./glass"

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
  const mode = draft.getByRole("combobox", { name: "Permission mode" })
  await expect(mode).toContainText("Auto")
  await mode.click()
  await window.getByRole("option", { name: "Default" }).click()
  await expect(mode).toContainText("Default")
  await expect(draft.getByRole("combobox", { name: "Base branch" })).toContainText("main")
  await draft.getByRole("textbox", { name: "Message" }).fill("Please run `touch notes.txt`")
  await draft.getByRole("textbox", { name: "Message" }).press("Enter")

  const card = window.getByRole("region", { name: "Allow Bash?" })
  await expect(card).toContainText('"command": "touch notes.txt"')
  await expect(
    window
      .getByRole("navigation", { name: "Agents list" })
      .getByRole("link", { description: /Waiting on you/ }),
  ).toHaveCount(1)
  await expect(window.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "aria-placeholder",
    "Answer the Permission request above first",
  )

  await card.getByRole("button", { name: "Allow" }).click()

  const transcript = window.getByRole("region", { name: "Transcript" })
  await expect(
    transcript.getByRole("button", { name: /^Done: Bash touch notes\.txt/ }),
  ).toBeVisible()
  await expect(transcript).toContainText(/Done in/)
  await expect(card).toContainText("Allowed")
  await expect(window.getByText("Waiting on you")).toHaveCount(0)
})
