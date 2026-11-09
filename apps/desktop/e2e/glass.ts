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
import type { TourAnswer } from "../../server/src/tourPrompt"
import { writeAgentCommands } from "../../server/test/agentCommands"
import { bundledPi } from "../../server/test/demoAgent"
import { startFakeAnthropic } from "../../server/test/fakeAnthropic"
import { type FakeModelSettings, fakeModelProvider } from "../../server/test/fakeModelProvider"
import { type FakeGitHub, startFakeGitHub } from "../../server/test/fakeGitHub"
import { type FakePullRequest, VIEWER } from "../../server/test/fakePullRequest"
import { fakeAnthropicEnvironment, pinnedClaude } from "../../server/test/pinnedClaude"

const desktopDir = join(import.meta.dirname, "..")

const electronPath: string = createRequire(import.meta.url)("electron")

const UNINHERITED = new Set(["VITE_DEV_SERVER_URL", "ELECTRON_RUN_AS_NODE", "GLASS_HOME"])

interface Claude {
  readonly answer: (tour: TourAnswer) => Promise<void>
  readonly command: string
  readonly environment: Readonly<Record<string, string>>
}

interface Glass {
  readonly home: string
  readonly git: boolean
  readonly github: FakeGitHub
  readonly claude: Claude
  readonly piModel: FakeModelSettings
  readonly pi: {
    readonly command: string
    readonly model: Effect.Success<ReturnType<typeof fakeModelProvider>>
  }
  readonly app: ElectronApplication
  readonly window: Page
  readonly relaunch: () => Promise<Page>
}

const launch = (glass: Pick<Glass, "github" | "claude" | "pi" | "home">) => {
  const { github, claude, pi, home } = glass
  writeAgentCommands(join(home, ".project-glass"), {
    claudeCommand: claude.command,
    piCommand: pi.command,
  })

  const inherited = Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || UNINHERITED.has(key) ? [] : [[key, value]],
  )

  return _electron.launch({
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
      ...claude.environment,
      // Keeps pi from refreshing its model catalog over the network.
      PI_OFFLINE: "1",
      GLASS_GIT_REMOTE: github.gitUrl,
    },
  })
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
  claude: async ({ home }, use) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(startFakeAnthropic, (anthropic) =>
          Effect.promise(() =>
            use({
              answer: (tour) =>
                Effect.runPromise(
                  anthropic.respond(() => ({ type: "text", text: JSON.stringify(tour) })),
                ),
              command: pinnedClaude(),
              environment: fakeAnthropicEnvironment(home, anthropic.url),
            }),
          ),
        ),
      ),
    )
  },
  piModel: [{}, { option: true }],
  pi: async ({ piModel, home }, use) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(fakeModelProvider(home, piModel, { retry: { enabled: false } }), (model) =>
          Effect.promise(() => use({ command: bundledPi, model })),
        ),
      ),
    )
  },
  app: async ({ github, claude, pi, home }, use) => {
    const app = await launch({ github, claude, pi, home })

    await use(app)
    await app.close()
  },
  window: async ({ app }, use) => {
    await use(await app.firstWindow())
  },
  relaunch: async ({ app, github, claude, pi, home }, use) => {
    const relaunched: Array<ElectronApplication> = []

    await use(async () => {
      await (relaunched.at(-1) ?? app).close()
      const next = await launch({ github, claude, pi, home })
      relaunched.push(next)

      return next.firstWindow()
    })

    for (const launched of relaunched) await launched.close()
  },
})

export { expect }

export const openPullRequest = async (window: Page, pr: FakePullRequest) => {
  await window.getByRole("link", { name: "Reviews", exact: true }).click()
  await window.getByRole("textbox", { name: "Open a PR" }).fill(pr.url)
  await window.getByRole("button", { name: "Open", exact: true }).click()
  await expect(window.getByRole("heading", { name: `${pr.title} #${pr.number}` })).toBeVisible()
}

export const startLineDraft = async (changes: Locator, line: string) => {
  const start = changes.getByRole("button", { name: "Start a Draft on this line" })

  await expect(async () => {
    await changes.getByText(line, { exact: true }).hover()
    await start.click({ timeout: 5000 })
    await expect(changes.getByRole("textbox", { name: /^Draft on / })).toBeVisible({
      timeout: 5000,
    })
  }).toPass()
}
