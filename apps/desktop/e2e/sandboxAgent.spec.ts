import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bundledPi } from "../../server/test/demoAgent"
import { fakeClaude } from "../../server/test/fakeClaude"
import { installFakeSandboxProvider } from "../../server/test/fakeSandboxProvider"
import { seedClone } from "../../server/test/gitRepositories"
import { expect, test as glass } from "./glass"

const repository = { owner: "glass-demo", repo: "greeter" }

const reply = [{ text: "Finished while you were away." }]

// Sandbox Agents drive `claude` through the Claude Agent SDK in the fake provider's Sandboxes,
// which hold each reply until the test lets it through.
const test = glass.extend<{
  sandboxes: ReturnType<typeof installFakeSandboxProvider>
  sandboxClaude: Effect.Success<ReturnType<typeof fakeClaude>>
}>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from it.
  sandboxClaude: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "glass-e2e-sandbox-claude-"))

    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(fakeClaude(directory, { reply, hang: true }), (claude) =>
          Effect.promise(() => use(claude)),
        ),
      ),
    )
    await rm(directory, { recursive: true, force: true })
  },
  sandboxes: async ({ home, sandboxClaude }, use) => {
    const { origin } = seedClone(join(home, "repositories"), repository.owner, repository.repo)

    const sandboxes = installFakeSandboxProvider(home, {
      root: join(home, "sandboxes"),
      cloneFrom: origin,
      piCommand: bundledPi,
      claudeCommand: sandboxClaude.command,
    })

    await use(sandboxes)
    await sandboxes.stopHosts()
  },
  // The provider must be installed before Glass starts, which loads Plugins once.
  claude: async ({ claude, sandboxes }, use) => {
    void sandboxes
    await use(claude)
  },
})

test("starts a Sandbox Agent, and fills in what it missed while its connection was down", async ({
  github,
  sandboxes,
  sandboxClaude,
  window,
}) => {
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
  const message = window.getByRole("textbox", { name: "Message" })
  await message.fill("Keep working")
  await message.press("Enter")

  await Effect.runPromise(sandboxClaude.logged("prompt", 1))
  const agentId = /#\/agents\/([^/?]+)/.exec(window.url())?.[1] ?? ""
  expect(agentId).not.toBe("new")
  sandboxes.dropConnections(agentId)
  await expect(
    window
      .getByRole("navigation", { name: "Agents list" })
      .getByRole("link", { description: /Can't reach its Sandbox/ }),
  ).toBeVisible()

  await Effect.runPromise(sandboxClaude.configure({ reply }))
  await Effect.runPromise(sandboxClaude.logged("replied", 1))
  sandboxes.reconnect(agentId)

  const transcript = window.getByRole("region", { name: "Transcript" })
  await expect(transcript).toContainText("Finished while you were away.")
  await expect(transcript).toContainText(/Done in/)
  await expect(window.getByText(/Can't reach its Sandbox/)).toHaveCount(0)
})
