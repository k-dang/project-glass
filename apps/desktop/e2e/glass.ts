import {
  _electron,
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test as base,
} from "@playwright/test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentReviewAnswer } from "../../server/src/agentReviewPrompt"
import type { AskAgentAnswer } from "../../server/src/askPrompt"
import type { TourAnswer } from "../../server/src/tourPrompt"
import { bundledPi } from "../../server/test/demoAgent"
import {
  claudeAnswer,
  installFakeAgent,
  piCliAnswer,
  piCliModels,
} from "../../server/test/fakeAgentFiles"
import { type FakeModelSettings, fakeModelProvider } from "../../server/test/fakeModelProvider"
import { type FakeGitHub, startFakeGitHub } from "../../server/test/fakeGitHub"
import { type FakePullRequest, VIEWER } from "../../server/test/fakePullRequest"

const desktopDir = join(import.meta.dirname, "..")

const electronPath: string = createRequire(import.meta.url)("electron")

const UNINHERITED = new Set(["VITE_DEV_SERVER_URL", "ELECTRON_RUN_AS_NODE", "GLASS_HOME"])

interface FakeClaude {
  readonly command: string
  readonly answer: (tour: TourAnswer) => Promise<void>
  readonly environment: Readonly<Record<string, string>>
}

interface FakePiCli {
  readonly command: string
  readonly answer: (answer: AgentReviewAnswer | AskAgentAnswer) => Promise<void>
}

interface Glass {
  readonly home: string
  readonly git: boolean
  readonly github: FakeGitHub
  readonly claude: FakeClaude
  readonly piCli: FakePiCli
  readonly realPiModel: FakeModelSettings | null
  readonly realPi: string | null
  readonly app: ElectronApplication
  readonly window: Page
}

export const test = base.extend<Glass>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from it.
  home: async ({}, use) => {
    const home = await mkdtemp(join(tmpdir(), "glass-e2e-"))

    await use(home)
    await rm(home, { recursive: true, force: true })
  },
  git: [false, { option: true }],
  github: async ({ git }, use) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(startFakeGitHub({ git }), (github) => Effect.promise(() => use(github))),
      ),
    )
  },
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from it.
  claude: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "glass-e2e-claude-"))
    const agent = await installFakeAgent(directory, "claude.cjs", { ready: true, output: "" })

    const answer = (tour: TourAnswer) =>
      agent.configure({ ready: true, output: claudeAnswer(tour) })

    await use({ command: agent.command, answer, environment: {} })
    await rm(directory, { recursive: true, force: true })
  },
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from it.
  piCli: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "glass-e2e-pi-"))
    const modelsOutput = piCliModels

    const agent = await installFakeAgent(directory, "pi.cjs", {
      ready: true,
      output: "",
      modelsOutput,
    })

    const answer = (answered: AgentReviewAnswer | AskAgentAnswer) =>
      agent.configure({
        ready: true,
        modelsOutput,
        output: piCliAnswer(JSON.stringify(answered)),
      })

    await use({ command: agent.command, answer })
    await rm(directory, { recursive: true, force: true })
  },
  realPiModel: [null, { option: true }],
  realPi: async ({ realPiModel, home }, use) => {
    if (realPiModel === null) return use(null)

    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(fakeModelProvider(home, realPiModel, { retry: { enabled: false } }), () =>
          Effect.promise(() => use(bundledPi)),
        ),
      ),
    )
  },
  app: async ({ github, claude, piCli, realPi, home }, use) => {
    const inherited = Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined || UNINHERITED.has(key) ? [] : [[key, value]],
    )

    const app = await _electron.launch({
      executablePath: electronPath,
      args: [
        "-r",
        join(import.meta.dirname, "background.cjs"),
        desktopDir,
        `--user-data-dir=${join(home, "user-data")}`,
      ],
      env: {
        ...Object.fromEntries(inherited),
        HOME: home,
        USERPROFILE: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
        GH_TOKEN: VIEWER.token,
        GLASS_GITHUB_API_URL: github.url,
        GLASS_CLAUDE_COMMAND: claude.command,
        ...claude.environment,
        GLASS_PI_COMMAND: realPi ?? piCli.command,
        // Keeps pi from refreshing its model catalog over the network.
        PI_OFFLINE: "1",
        GLASS_GIT_REMOTE: github.gitUrl,
      },
    })

    await use(app)
    await app.close()
  },
  window: async ({ app }, use) => {
    await use(await app.firstWindow())
  },
})

export { expect }

export const openPullRequest = async (window: Page, pr: FakePullRequest) => {
  await window.getByRole("textbox", { name: "Open a PR" }).fill(pr.url)
  await window.getByRole("button", { name: "Open", exact: true }).click()
  await expect(window.getByRole("heading", { name: `${pr.title} #${pr.number}` })).toBeVisible()
}

export const startLineDraft = async (changes: Locator, line: string) => {
  const start = changes.getByRole("button", { name: "Start a Draft on this line" })

  // The diff can render again after the hover, dropping the gutter button until the pointer moves.
  await expect(async () => {
    await changes.getByText(line, { exact: true }).hover()
    await start.click({ timeout: 5000 })
    await expect(changes.getByRole("textbox", { name: /^Draft on / })).toBeVisible({
      timeout: 5000,
    })
  }).toPass()
}
