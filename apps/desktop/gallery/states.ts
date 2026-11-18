import type { Page } from "@playwright/test"
import { REPLAYED_PREFIX } from "../../server/test/replayedNames.ts"

export interface State {
  readonly area: string
  readonly name: string
  readonly reach: (window: Page) => Promise<void | "nothing new">
  readonly wholeTranscript?: true
}

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

const conversationsList = async (window: Page) => {
  await area(window, "Conversations")

  return window.getByRole("navigation", { name: "Conversations list" })
}

const conversation = async (window: Page, status: RegExp) => {
  await (
    await conversationsList(window)
  )
    .getByRole("link", { description: status })
    .filter({ hasNotText: REPLAYED_PREFIX })
    .first()
    .click()
  await window.getByRole("region", { name: "Transcript" }).waitFor()
}

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
    reach: async (window) => {
      await pullRequest(window, "Fix the typo in the README")
      await window.getByRole("button", { name: /^Finish Review/ }).click()
      await visible(window, "dialog", "Finish your Review")
    },
  },
  {
    area: "PR workspace",
    name: "Agent review and Discussions",
    reach: async (window) => {
      await pullRequest(window, "Rate-limit the public API")
      await workspaceTab(window, "Overview")
      await window.getByText("Can we ship this behind the flag first").first().waitFor()
      await window.getByText("Any caller can mint a fresh bucket").first().waitFor()
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
  // Writing a Tour can't be repeated, so Saved Tour and Reading a Tour carry on from the state before.
  {
    area: "Tours",
    name: "Saved Tour",
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
    area: "Conversations",
    name: "New Conversation",
    reach: async (window) => {
      await area(window, "Conversations")
      await window.getByRole("link", { name: "New Conversation" }).click()
      await visible(window, "heading", "What should we work on?")
    },
  },
  {
    area: "Conversations",
    name: "Finished",
    reach: (window) => conversation(window, /Finished/),
  },
  {
    area: "Conversations",
    name: "Waiting on a Permission request",
    reach: async (window) => {
      const waiting = (await conversationsList(window))
        .getByRole("link", { description: /Waiting on you/ })
        .filter({ hasNotText: REPLAYED_PREFIX })

      for (const link of await waiting.all()) {
        await link.click()
        const allow = window.getByRole("button", { name: "Allow", exact: true })
        const question = window.getByRole("radiogroup")
        await allow.or(question).first().waitFor()

        if (await allow.isVisible()) return
      }

      throw new Error("No Conversation is waiting on a Permission request")
    },
  },
  {
    area: "Conversations",
    name: "Failed",
    reach: (window) => conversation(window, /Failed/),
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
    reach: async (window) => {
      await area(window, "Dashboard")
      await window.getByRole("button", { name: /^Keyboard shortcuts/ }).click()
      await visible(window, "textbox", "Search keyboard shortcuts")
    },
  },
  {
    area: "Overlays",
    name: "Resource usage",
    reach: async (window) => {
      await area(window, "Dashboard")
      await window.getByRole("button", { name: "Show Glass resource usage" }).click()
      await visible(window, "table", "Resource usage by process")
    },
  },
  {
    area: "Overlays",
    name: "Global conversation",
    reach: async (window) => {
      await area(window, "Dashboard")
      await window.getByRole("button", { name: "Global conversation" }).click()
      await visible(window, "dialog", /Global conversation/)
    },
  },
]

const replayGroups = { "claude-code": "Claude Code replays", pi: "pi replays" }

interface Replay {
  readonly harness: keyof typeof replayGroups
  readonly scenario: string
}

const openReplayed = async (window: Page, { harness, scenario }: Replay) => {
  const link = (await conversationsList(window)).getByRole("link", {
    name: `${REPLAYED_PREFIX}${harness}/${scenario}`,
    exact: true,
  })

  const href = await link.getAttribute("href")
  await link.click()
  await window.waitForURL((url) => href !== null && url.href.endsWith(href))
  await window.getByRole("region", { name: "Transcript" }).waitFor()
}

const expandAll = async (window: Page) => {
  const transcript = window.getByRole("region", { name: "Transcript" })
  const collapsed = transcript.locator('button[aria-expanded="false"]')

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
  const links = (await conversationsList(window)).getByRole("link", {
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
      reach: (window: Page) => openReplayed(window, replay),
    },
    {
      area: replayGroups[replay.harness],
      name: `${replay.scenario}, expanded`,
      wholeTranscript: true,
      reach: async (window: Page) => {
        await openReplayed(window, replay)

        return expandAll(window)
      },
    },
  ])
