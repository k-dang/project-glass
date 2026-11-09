import { shortSha } from "@glass/contracts"
import { Effect } from "effect"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bundledPi } from "../../server/test/demoAgent"
import { installFakeSandboxProvider } from "../../server/test/fakeSandboxProvider"
import { seedClone } from "../../server/test/gitRepositories"
import { expect, test as glass } from "./glass"

const repository = { owner: "glass-demo", repo: "greeter" }

const reply = "Finished while you were away."

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name} well.\n`

const test = glass.extend<{
  sandboxes: ReturnType<typeof installFakeSandboxProvider>
}>({
  sandboxes: [
    async ({ home }, use) => {
      const { origin } = seedClone(join(home, "repositories"), repository.owner, repository.repo)

      const sandboxes = installFakeSandboxProvider(home, {
        root: join(home, "sandboxes"),
        cloneFrom: origin,
        piCommand: bundledPi,
        claudeCommand: "glass-missing-claude",
        home: join(home, "sandbox-home"),
      })

      await use(sandboxes)
      await sandboxes.stopHosts()
    },
    { auto: true },
  ],
})

test.use({ piModel: { output: reply, hang: true } })

test("starts a Sandbox Agent, and fills in what it missed while its connection was down", async ({
  github,
  pi: { model },
  sandboxes,
  window,
}, testInfo) => {
  testInfo.setTimeout(90_000)
  github.seedBranches(repository, { defaultBranch: "main", branches: ["main"] })

  await window.getByRole("link", { name: "Settings" }).click()
  await window.getByRole("textbox", { name: "Repository", exact: true }).fill("glass-demo/greeter")
  await window.getByRole("button", { name: "Follow" }).click()
  await expect(window.getByRole("list", { name: "Followed repositories" })).toContainText(
    "glass-demo/greeter",
  )

  await window.getByRole("link", { name: "Agents" }).click()
  await window.getByRole("combobox", { name: "Where the Agent runs" }).click()
  await window.getByRole("option", { name: "Fake Sandboxes" }).click()
  await expect(window.getByRole("combobox", { name: "Base branch" })).toContainText("main")
  await window.getByRole("button", { name: /^Claude Code:/ }).click()
  await window
    .getByRole("group", { name: "Agent program" })
    .getByRole("button", { name: "pi" })
    .click()
  await window.keyboard.press("Escape")
  const message = window.getByRole("textbox", { name: "Message" })
  await message.fill("Keep working")
  await message.press("Enter")

  await Effect.runPromise(model.received(1))
  const agentId = /#\/agents\/([^/?]+)/.exec(window.url())?.[1] ?? ""
  expect(agentId).not.toBe("new")
  await sandboxes.dropConnections(agentId)
  await expect(
    window
      .getByRole("navigation", { name: "Agents list" })
      .getByRole("link", { description: /Can't reach its Sandbox/ }),
  ).toBeVisible()

  await Effect.runPromise(model.release({ output: reply }))
  sandboxes.reconnect(agentId)

  const transcript = window.getByRole("region", { name: "Transcript" })
  await expect(transcript).toContainText(reply)
  await expect(transcript).toContainText(/Done in/)
  await expect(window.getByText(/Can't reach its Sandbox/)).toHaveCount(0)
})

test("gives a Sandbox Agent a Skill pack and the Local skills, and shows both", async ({
  github,
  home,
  pi: { model },
  window,
}, testInfo) => {
  testInfo.setTimeout(90_000)
  github.seedBranches(repository, { defaultBranch: "main", branches: ["main"] })

  const commit = github.pushRepository({ owner: "acme", repo: "skills" }, "main", {
    "team/architect/SKILL.md": skill("architect", "Shape a design."),
  })

  const dotfiles = join(home, "dotfiles", "grilling")
  mkdirSync(dotfiles, { recursive: true })
  writeFileSync(join(dotfiles, "SKILL.md"), skill("grilling", "Ask hard questions."))
  mkdirSync(join(home, ".agents", "skills"), { recursive: true })
  symlinkSync(dotfiles, join(home, ".agents", "skills", "grilling"))

  await window.getByRole("link", { name: "Settings" }).click()
  await window.getByRole("textbox", { name: "Repository", exact: true }).fill("glass-demo/greeter")
  await window.getByRole("button", { name: "Follow" }).click()
  await expect(window.getByRole("list", { name: "Followed repositories" })).toContainText(
    "glass-demo/greeter",
  )
  await window
    .getByRole("textbox", { name: "GitHub URL" })
    .fill("https://github.com/acme/skills/tree/main/team")
  await window.getByRole("button", { name: "Preview" }).click()
  await window.getByRole("button", { name: "Add pack" }).click()
  await expect(window.getByRole("list", { name: "Skill packs" })).toContainText("team")

  await window.getByRole("link", { name: "Agents" }).click()
  await window.getByRole("combobox", { name: "Where the Agent runs" }).click()
  await window.getByRole("option", { name: "Fake Sandboxes" }).click()
  await expect(window.getByRole("combobox", { name: "Base branch" })).toContainText("main")
  await window.getByRole("button", { name: /^Claude Code:/ }).click()
  await window
    .getByRole("group", { name: "Agent program" })
    .getByRole("button", { name: "pi" })
    .click()
  await window.keyboard.press("Escape")
  await window.getByRole("combobox", { name: "Skill packs" }).click()
  await window.getByRole("option", { name: "team" }).click()
  await window.keyboard.press("Escape")
  await window.getByRole("checkbox", { name: "Local skills" }).click()
  const message = window.getByRole("textbox", { name: "Message" })
  await message.fill("Keep working")
  await message.press("Enter")

  await Effect.runPromise(model.received(1))
  await message.pressSequentially("/skill:")
  const commands = window.getByRole("listbox", { name: "Commands" })
  await expect(commands).toContainText("/skill:architect")
  await expect(commands).toContainText("/skill:grilling")

  await window.getByRole("button", { name: "Details" }).click()
  await expect(window.getByText(`team @ ${shortSha(commit)} · Local skills`)).toBeVisible()
})
