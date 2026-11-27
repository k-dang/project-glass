import type { Locator, Page } from "@playwright/test"
import { REPLAYED_PREFIX } from "../server/test/replayedNames.ts"

export interface State {
  readonly area: string
  readonly name: string
  readonly reach: (window: Page) => Promise<void | "nothing new">
  readonly focus?: (window: Page) => Locator
  readonly focusPadding?: number
  readonly wholeTranscript?: true
}

const transcript = (window: Page) => window.getByRole("region", { name: "Transcript" })

const turns = (window: Page) =>
  transcript(window).locator('[data-slot="message-scroller-content"] > *')

const area = async (window: Page, name: string) => {
  await window.keyboard.press("Escape")
  await window
    .getByRole("navigation", { name: "App areas" })
    .getByRole("link", { name, exact: true })
    .click()
}

const reviewsList = async (window: Page, list: string, arrangement = "Recent") => {
  await area(window, "Reviews")
  const back = window.getByRole("button", { name: "Back to PRs" })

  if (await back.isVisible()) await back.click()
  await window
    .getByRole("group", { name: "Arrange PRs" })
    .getByRole("button", { name: arrangement })
    .click()
  await window.getByRole("tab", { name: list }).click()
}

const pullRequest = async (window: Page, title: string, list = "Needs review") => {
  await reviewsList(window, list)
  await window.getByRole("button", { name: new RegExp(`^${title}`) }).click()
  await window.getByRole("heading", { name: new RegExp(`^${title} #\\d+`) }).waitFor()
}

const workspaceTab = async (window: Page, tab: string) => {
  await window
    .getByRole("tablist", { name: "PR workspace" })
    .getByRole("tab", { name: tab })
    .click()
}

const fileTab = async (window: Page, tab: string | RegExp) => {
  await window.getByRole("tablist", { name: "File panel" }).getByRole("tab", { name: tab }).click()
}

const threadsList = async (window: Page) => {
  await area(window, "Threads")

  return window.getByRole("navigation", { name: "Threads list" })
}

const demoRows = (list: Locator) => list.getByRole("link").filter({ hasNotText: REPLAYED_PREFIX })

const markers = /Finished|Working|Waiting on you|Failed|Interrupted/

const listRow = (
  name: string,
  row: (list: Locator) => Locator,
  setUp?: (window: Page) => Promise<void>,
): State => {
  const found = (window: Page) =>
    row(window.getByRole("navigation", { name: "Threads list" })).first()

  return {
    area: "Threads list",
    name,
    focus: found,
    focusPadding: 0,
    reach: async (window) => {
      await threadsList(window)
      await setUp?.(window)
      await found(window).scrollIntoViewIfNeeded()
    },
  }
}

const finishedRows = (list: Locator) =>
  list.getByRole("link", { description: /Finished/ }).filter({ hasNotText: REPLAYED_PREFIX })

const workingRow = (list: Locator) =>
  list.getByRole("link", { name: "demo/keeps-working", exact: true })

const openRow = async (window: Page, row: (list: Locator) => Locator) => {
  const list = await threadsList(window)
  const href = await row(list).getAttribute("href")
  await row(list).click()
  await list.locator(`a[href="${href}"][aria-current="page"]`).waitFor()
}

const thread = async (window: Page, status: RegExp) => {
  await (
    await threadsList(window)
  )
    .getByRole("link", { description: status })
    .filter({ hasNotText: REPLAYED_PREFIX })
    .first()
    .click()
  await transcript(window).waitFor()
}

const dialog = (name?: string | RegExp) => (window: Page) =>
  window.getByRole("dialog", name === undefined ? {} : { name })

const visible = (window: Page, role: Parameters<Page["getByRole"]>[0], name: string | RegExp) =>
  window.getByRole(role, { name }).first().waitFor()

export const states: ReadonlyArray<State> = [
  {
    area: "Dashboard",
    name: "Dashboard",
    reach: async (window) => {
      await area(window, "Dashboard")
      await visible(window, "list", "Open to-dos")
      await visible(window, "list", "Activity totals")
    },
  },
  {
    area: "Inbox",
    name: "Question from an outside agent",
    focus: (window) =>
      window
        .getByRole("heading", { name: "Ship the retry change?" })
        .or(window.locator("form").filter({ has: window.getByRole("radiogroup") })),
    reach: async (window) => {
      await area(window, "Inbox")
      await visible(window, "radiogroup", "Choices")
    },
  },
  {
    area: "Reviews",
    name: "Needs review",
    reach: async (window) => {
      await reviewsList(window, "Needs review")
      await visible(window, "button", /^Rate-limit the public API/)
    },
  },
  {
    area: "Reviews",
    name: "Needs review, by repository",
    reach: async (window) => {
      await reviewsList(window, "Needs review", "By repository")
      await visible(window, "button", /^Rate-limit the public API/)
    },
  },
  {
    area: "Reviews",
    name: "My PRs",
    reach: async (window) => {
      await reviewsList(window, "My PRs")
      await visible(window, "button", /^Retry failed webhook deliveries/)
    },
  },
  {
    area: "Reviews",
    name: "Reviewing",
    reach: async (window) => {
      await reviewsList(window, "Reviewing")
      await window.getByRole("tabpanel", { name: "Reviewing" }).waitFor()
    },
  },
  {
    area: "Reviews",
    name: "Queue",
    reach: async (window) => {
      await reviewsList(window, "Queue")
      await window.getByRole("tabpanel", { name: "Queue" }).waitFor()
    },
  },
  {
    area: "PR workspace",
    name: "Overview with a Draft",
    focus: (window) =>
      window
        .locator("section")
        .filter({ has: window.getByRole("heading", { name: /^Your Drafts/ }) })
        .last(),
    reach: async (window) => {
      await pullRequest(window, "Fix the typo in the README")
      await workspaceTab(window, "Overview")
      await visible(window, "heading", /^Your Drafts/)
    },
  },
  {
    area: "PR workspace",
    name: "Changes with a Draft",
    reach: async (window) => {
      await pullRequest(window, "Fix the typo in the README")
      await workspaceTab(window, "Changes")
      await visible(window, "textbox", "Draft on README.md line +1")
    },
  },
  {
    area: "PR workspace",
    name: "Finish your Review",
    focus: dialog("Finish your Review"),
    reach: async (window) => {
      await pullRequest(window, "Fix the typo in the README")
      await window.getByRole("button", { name: /^Finish Review/ }).click()
      await visible(window, "dialog", "Finish your Review")
    },
  },
  {
    area: "PR workspace",
    name: "Agent review and Review threads",
    reach: async (window) => {
      await pullRequest(window, "Rate-limit the public API")
      await workspaceTab(window, "Overview")
      await window.getByText("Can we ship this behind the flag first").first().waitFor()
      await window.getByText("Any caller can mint a fresh bucket").first().waitFor()
    },
  },
  {
    area: "PR workspace",
    name: "Agent review beside the diff",
    reach: async (window) => {
      await pullRequest(window, "Rate-limit the public API")
      await workspaceTab(window, "Overview")
      await window
        .getByRole("list", { name: "Hotspots" })
        .getByRole("button", { name: /Any caller can mint a fresh bucket/ })
        .click()

      const point = window
        .getByRole("complementary", { name: "Agent review" })
        .getByRole("listitem")
        .filter({ hasText: "Any caller can mint a fresh bucket" })

      await point.getByRole("button", { name: /middleware\.ts/ }).click()
      await window.getByRole("tab", { name: "Changes", selected: true }).waitFor()
      await window.getByRole("button", { name: "Hide file panel" }).click()
      await point.evaluate((element) => element.scrollIntoView({ block: "start" }))
      await window.mouse.move(0, 0)
    },
  },
  {
    area: "PR workspace",
    name: "Changes across several files",
    reach: async (window) => {
      await pullRequest(window, "Rate-limit the public API")
      await workspaceTab(window, "Changes")
      await visible(window, "treeitem", /middleware/)
    },
  },
  {
    area: "PR workspace",
    name: "Notes",
    reach: async (window) => {
      await pullRequest(window, "Rate-limit the public API")
      await workspaceTab(window, "Changes")
      await fileTab(window, /^Notes/)
      await window.getByRole("tabpanel", { name: /^Notes/ }).waitFor()
    },
  },
  {
    area: "PR workspace",
    name: "Repository",
    reach: async (window) => {
      await pullRequest(window, "Rate-limit the public API")
      await workspaceTab(window, "Repository")
      await window.getByRole("tabpanel", { name: "Repository" }).waitFor()
    },
  },
  {
    area: "PR workspace",
    name: "Failing checks and requested changes",
    reach: async (window) => {
      await pullRequest(window, "Retry failed webhook deliveries", "My PRs")
      await workspaceTab(window, "Overview")
      await window.getByText("Back off between attempts").first().waitFor()
    },
  },
  {
    area: "Tours",
    name: "Write a Tour",
    reach: async (window) => {
      await pullRequest(window, "Tour example: validate before saving")
      await fileTab(window, "Tour")
      await visible(window, "button", "Write Tour")
    },
  },
  {
    area: "Tours",
    name: "Saved Tour",
    focus: (window) => window.getByRole("region", { name: "Saved Tour" }),
    reach: async (window) => {
      await window.getByRole("button", { name: "Write Tour" }).click()
      await visible(window, "region", "Saved Tour")
    },
  },
  {
    area: "Tours",
    name: "Reading a Tour",
    reach: async (window) => {
      await window
        .getByRole("region", { name: "Notifications" })
        .getByRole("button", { name: "Start reading" })
        .click()
      await window
        .getByRole("region", { name: "Notifications" })
        .getByRole("dialog")
        .waitFor({ state: "detached" })
    },
  },
  {
    area: "To-dos",
    name: "To-dos",
    reach: async (window) => {
      await area(window, "To-dos")
      await visible(window, "list", "Open to-dos")
    },
  },
  {
    area: "Threads",
    name: "New Thread",
    reach: async (window) => {
      await area(window, "Threads")
      await window.getByRole("link", { name: "New Thread" }).click()
      await visible(window, "heading", "What should we work on?")
    },
  },
  {
    area: "Threads list",
    name: "Whole list",
    focus: (window) => demoRows(window.getByRole("navigation", { name: "Threads list" })),
    reach: async (window) => {
      const list = await threadsList(window)

      for (const marker of [/Working/, /Waiting on you/, /Failed/, /PR #\d+/])
        await list.getByRole("link", { description: marker }).first().waitFor()

      await demoRows(list).last().scrollIntoViewIfNeeded()
    },
  },
  listRow("Finished", finishedRows),
  listRow("Working", (list) => list.getByRole("link", { description: /Working/ })),
  listRow("Waiting on you", (list) => list.getByRole("link", { description: /Waiting on you/ })),
  listRow("Failed", (list) =>
    list.getByRole("link", { description: /Failed/ }).filter({ hasNotText: REPLAYED_PREFIX }),
  ),
  listRow("Interrupted", (list) => list.getByRole("link", { description: /Interrupted/ })),
  listRow("Linked to a PR", (list) => list.getByRole("link", { description: /PR #\d+/ })),
  {
    area: "Threads",
    name: "Remove a Thread with uncommitted changes",
    focus: (window) => window.getByRole("alertdialog", { name: /^Remove / }),
    reach: async (window) => {
      const list = await threadsList(window)

      const finished = await demoRows(list)
        .filter({ has: window.getByText("Finished", { exact: true }) })
        .evaluateAll((links) => links.map((link) => link.getAttribute("href")))

      for (const href of finished) {
        if (href === null) continue

        const row = list.locator(`a[href="${href}"]`)
        await row.click()
        await window.waitForURL((url) => url.href.endsWith(href))
        await turns(window).first().waitFor()

        if (!(await transcript(window).getByText("Write a note", { exact: true }).isVisible()))
          continue

        await row.hover()
        await window
          .getByRole("button", { name: `Remove ${await row.getAttribute("aria-label")}` })
          .click()
        await window.getByText("Its worktree has uncommitted changes").waitFor()

        return
      }

      throw new Error("No Thread wrote a note")
    },
  },
  {
    area: "Threads list",
    name: "Open",
    focus: (window) =>
      window.getByRole("navigation", { name: "Threads list" }).locator('a[aria-current="page"]'),
    focusPadding: 0,
    reach: async (window) => {
      await openRow(window, workingRow)
      await window.mouse.move(0, 0)
    },
  },
  listRow(
    "Seen",
    (list) =>
      demoRows(list)
        .and(list.locator('a:not([aria-current="page"])'))
        .filter({ hasNotText: markers }),
    async (window) => {
      await openRow(window, (list) => finishedRows(list).last())
      await openRow(window, workingRow)
    },
  ),
  {
    area: "Threads",
    name: "Finished",
    focus: turns,
    reach: (window) => thread(window, /Finished/),
  },
  {
    area: "Threads",
    name: "Waiting on a Permission request",
    focus: turns,
    reach: async (window) => {
      const waiting = (await threadsList(window))
        .getByRole("link", { description: /Waiting on you/ })
        .filter({ hasNotText: REPLAYED_PREFIX })

      for (const link of await waiting.all()) {
        await link.click()
        const allow = window.getByRole("button", { name: "Allow", exact: true })
        const question = window.getByRole("radiogroup")
        await allow.or(question).first().waitFor()

        if (await allow.isVisible()) {
          await window.getByRole("button", { name: "Hide details" }).click()

          return
        }
      }

      throw new Error("No Thread is waiting on a Permission request")
    },
  },
  {
    area: "Threads",
    name: "Failed",
    focus: turns,
    reach: (window) => thread(window, /Failed/),
  },
  {
    area: "Activity",
    name: "Activity",
    reach: async (window) => {
      await area(window, "Activity")
      await visible(window, "region", "Today")
    },
  },
  {
    area: "Settings",
    name: "Settings",
    reach: async (window) => {
      await area(window, "Settings")
      await visible(window, "region", "Storage")
    },
  },
  {
    area: "Overlays",
    name: "Keyboard shortcuts",
    focus: dialog(),
    reach: async (window) => {
      await area(window, "Dashboard")
      await window.getByRole("button", { name: /^Keyboard shortcuts/ }).click()
      await visible(window, "textbox", "Search keyboard shortcuts")
    },
  },
  {
    area: "Overlays",
    name: "Resource usage",
    focus: dialog(),
    reach: async (window) => {
      await area(window, "Dashboard")
      await window.getByRole("button", { name: "Show Glass resource usage" }).click()
      await visible(window, "table", "Resource usage by process")
    },
  },
  {
    area: "Overlays",
    name: "Global chat",
    focus: dialog(/Global chat/),
    reach: async (window) => {
      await area(window, "Dashboard")
      await window.getByRole("button", { name: "Global chat" }).click()
      await visible(window, "dialog", /Global chat/)
    },
  },
]

const replayGroups = { "claude-code": "Claude Code replays", pi: "pi replays" }

interface Replay {
  readonly harness: keyof typeof replayGroups
  readonly scenario: string
}

const openReplayed = async (window: Page, { harness, scenario }: Replay) => {
  const link = (await threadsList(window)).getByRole("link", {
    name: `${REPLAYED_PREFIX}${harness}/${scenario}`,
    exact: true,
  })

  const href = await link.getAttribute("href")
  await link.click()
  await window.waitForURL((url) => href !== null && url.href.endsWith(href))
  await transcript(window).waitFor()
}

const expandAll = async (window: Page) => {
  const collapsed = transcript(window).locator('button[aria-expanded="false"]')

  if ((await collapsed.count()) === 0) return "nothing new"

  while ((await collapsed.count()) > 0)
    await collapsed.evaluateAll((buttons) => {
      for (const button of buttons) if ("click" in button) button.click()
    })

  return undefined
}

const replayOf = (label: string): ReadonlyArray<Replay> => {
  const [harness, scenario] = label.slice(REPLAYED_PREFIX.length).split("/")

  return (harness === "claude-code" || harness === "pi") && scenario !== undefined
    ? [{ harness, scenario }]
    : []
}

export const replays = async (window: Page) => {
  const links = (await threadsList(window)).getByRole("link", {
    name: new RegExp(`^${REPLAYED_PREFIX}`),
  })

  await links.first().waitFor()

  const labels = await links.evaluateAll((found) => found.map((link) => link.ariaLabel))

  return labels
    .flatMap((label) => (label === null ? [] : replayOf(label)))
    .toSorted((a, b) => a.scenario.localeCompare(b.scenario))
}

export const replayedStates = (found: ReadonlyArray<Replay>): ReadonlyArray<State> =>
  found.flatMap((replay) => [
    {
      area: replayGroups[replay.harness],
      name: replay.scenario,
      wholeTranscript: true,
      focus: turns,
      reach: (window: Page) => openReplayed(window, replay),
    },
    {
      area: replayGroups[replay.harness],
      name: `${replay.scenario}, expanded`,
      wholeTranscript: true,
      focus: turns,
      reach: async (window: Page) => {
        await openReplayed(window, replay)

        return expandAll(window)
      },
    },
  ])
