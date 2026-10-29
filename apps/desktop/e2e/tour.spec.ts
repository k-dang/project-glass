import type { Page } from "@playwright/test"
import { Effect } from "effect"
import type { FakeGitHub } from "../../server/test/fakeGitHub"
import { fakeModelProvider } from "../../server/test/fakeModelProvider"
import { expect, openPullRequest, startLineDraft, test } from "./glass"

const numbered = (count: number, word = "line") =>
  Array.from({ length: count }, (_, index) => `${word} ${index + 1}`)

const added = (lines: ReadonlyArray<string>) =>
  `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`

const greetBase = numbered(30)

const greetHead = greetBase.map((line) => (line === "line 20" ? "line twenty" : line))

const docs = numbered(80, "doc")

const big = numbered(80, "big")

const tour = {
  intent: "Spell out the greeting.",
  chapters: [
    {
      title: "Spell out the greeting",
      explanation: "The greeting writes its numbers as words.",
      files: [
        { path: "greet.ts", summary: "Writes twenty in words." },
        { path: "big.ts", summary: "Adds the long table." },
      ],
    },
    {
      title: "Document the greeting",
      explanation: "The docs describe the new wording.",
      files: [{ path: "docs.md", summary: "Describes the wording." }],
    },
  ],
  unplacedFiles: [],
}

const writeTour = async (window: Page) => {
  await window.getByRole("tab", { name: "Tour" }).click()
  await window.getByRole("button", { name: "Write Tour" }).click()
  await expect(window.getByRole("region", { name: "Saved Tour" })).toBeVisible()

  const notifications = window.getByRole("region", { name: "Notifications" })
  await notifications.getByRole("button", { name: "Start reading" }).click()
  await expect(notifications.getByRole("dialog")).toHaveCount(0)
}

const seedTourPullRequest = (github: FakeGitHub) =>
  github.seedPullRequest({
    base: { sha: "b0", files: { "greet.ts": `${greetBase.join("\n")}\n` } },
    head: {
      sha: "h1",
      files: {
        "greet.ts": `${greetHead.join("\n")}\n`,
        "big.ts": `${big.join("\n")}\n`,
        "docs.md": `${docs.join("\n")}\n`,
        "notes.txt": "note\n",
      },
    },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch:
          "@@ -17,7 +17,7 @@\n line 17\n line 18\n line 19\n-line 20\n+line twenty\n line 21\n line 22\n line 23",
      },
      { path: "big.ts", status: "added", additions: big.length, patch: added(big) },
      { path: "docs.md", status: "added", additions: docs.length, patch: added(docs) },
      { path: "notes.txt", status: "added", additions: 1, patch: added(["note"]) },
    ],
  })

// Pi settings must exist before the backend fills in defaults during startup.
const piTest = test.extend<{ pi: Effect.Success<ReturnType<typeof fakeModelProvider>> }>({
  pi: [
    async ({ home }, use) => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(fakeModelProvider(home, { output: JSON.stringify(tour) }), (pi) =>
            Effect.promise(() => use(pi)),
          ),
        ),
      )
    },
    { auto: true },
  ],
})

piTest("writes a Tour with the bundled Pi SDK", async ({ github, pi, window }) => {
  await window.getByRole("link", { name: "Settings" }).click()
  const tours = window.getByRole("region", { name: "Tours" })
  await tours.getByText("pi", { exact: true }).click()
  await expect(tours.getByRole("radio", { name: "pi", exact: true })).toBeChecked()
  await window.getByRole("button", { name: "Save changes" }).click()
  await expect(window.getByText("Settings saved.")).toBeAttached()
  await window.getByRole("link", { name: "Reviews" }).click()
  await openPullRequest(window, seedTourPullRequest(github))
  await writeTour(window)
  await expect(
    window.getByRole("tabpanel", { name: "Changes" }).getByText("Writes twenty in words."),
  ).toBeVisible()
  expect(pi.calls).toHaveLength(1)
})

test("moves between Chapters from the keyboard and the sidebar in a tall window", async ({
  github,
  claude,
  window,
}) => {
  await window.setViewportSize({ width: 1600, height: 1200 })
  await claude.answer({
    ...tour,
    chapters: [
      tour.chapters[0]!,
      {
        ...tour.chapters[1]!,
        files: [{ path: "notes.txt", summary: "Adds a note." }, ...tour.chapters[1]!.files],
      },
    ],
  })
  await openPullRequest(window, seedTourPullRequest(github))
  await writeTour(window)

  const changes = window.getByRole("tabpanel", { name: "Changes" })
  const first = changes.getByRole("heading", { name: "Spell out the greeting" })
  const second = changes.getByRole("heading", { name: "Document the greeting" })
  const last = changes.getByRole("region", { name: "Document the greeting" })
  const docsLink = last.getByRole("navigation").getByRole("button", { name: /docs.md/ })
  await expect(first).toBeInViewport()

  await window.keyboard.press("]")
  await expect(docsLink).toBeInViewport({ ratio: 1 })
  await window.keyboard.press("[")
  await expect(first).toBeInViewport()

  await window.keyboard.press("]")
  await last.locator(".overflow-auto").hover()
  await window.mouse.wheel(0, 2000)
  await expect(docsLink).toHaveAttribute("aria-current", "location")

  await changes.getByRole("button", { name: "Path" }).click()
  await window.getByRole("tab", { name: "Overview" }).click()
  await window.getByRole("button", { name: /Document the greeting/ }).click()
  await expect(second).toBeInViewport()
})

test("finds matches across Chapters and Everything else", async ({ github, claude, window }) => {
  await claude.answer(tour)
  await openPullRequest(window, seedTourPullRequest(github))
  await writeTour(window)

  const changes = window.getByRole("tabpanel", { name: "Changes" })
  await changes.getByText("line twenty", { exact: true }).click()
  await window.keyboard.press("ControlOrMeta+f")
  const search = changes.getByPlaceholder("Search", { exact: true })

  await search.fill("doc 80")
  await expect(changes.getByText("1 of 1", { exact: true })).toBeVisible()
  await expect(changes.getByText("doc 80", { exact: true })).toBeInViewport()
  await expect
    .poll(() =>
      window.evaluate<string[]>(
        "Array.from(CSS.highlights.get('diffs-search-focus') ?? [], range => range.toString())",
      ),
    )
    .toContain("doc 80")

  await changes.getByText("doc 80", { exact: true }).click()
  await window.keyboard.press("ControlOrMeta+f")
  await expect(search).toHaveValue("doc 80")
  await search.fill("line twenty|doc 80|note")
  await changes.getByRole("button", { name: "Regexp", exact: true }).click()
  await expect(changes.getByText("1 of 3", { exact: true })).toBeVisible()
  await expect(changes.getByText("line twenty", { exact: true })).toBeInViewport()
  await search.press("Enter")
  await expect(changes.getByText("2 of 3", { exact: true })).toBeVisible()
  await expect(changes.getByText("doc 80", { exact: true })).toBeInViewport()
  await search.press("Enter")
  await expect(changes.getByText("3 of 3", { exact: true })).toBeVisible()
  await expect(changes.getByText("note", { exact: true })).toBeInViewport()
  await search.press("Shift+Enter")
  await expect(changes.getByText("2 of 3", { exact: true })).toBeVisible()
  await expect(changes.getByText("doc 80", { exact: true })).toBeInViewport()
})

test("keeps Replies, Drafts and full-file context in Tour order", async ({
  github,
  claude,
  window,
}) => {
  await claude.answer(tour)
  const pr = seedTourPullRequest(github)

  pr.addReviewThread({
    path: "greet.ts",
    line: 21,
    comments: [{ author: "hubot", bodyHtml: "<p>Why words?</p>" }],
  })

  await openPullRequest(window, pr)
  await writeTour(window)

  const changes = window.getByRole("tabpanel", { name: "Changes" })
  await expect(changes.getByText("Writes twenty in words.")).toBeVisible()

  await changes
    .getByRole("textbox", { name: /^Reply to thread on greet\.ts/ })
    .fill("They read better.")
  await changes.getByRole("button", { name: "Reply", exact: true }).click()
  await expect
    .poll(() => pr.reviewThreads[0]?.comments.map(({ bodyHtml }) => bodyHtml))
    .toContain("<p>They read better.</p>")

  await startLineDraft(changes, "line twenty")
  const draft = changes.getByRole("textbox", { name: "Draft on greet.ts line +20" })
  await draft.fill("Spell all?")
  await draft.press("Enter")
  await expect(changes.getByText("Saved privately")).toBeVisible()

  await expect(changes.getByText("line 5", { exact: true })).toHaveCount(0)
  await changes.locator("[data-expand-button]").first().click()
  await expect(changes.getByText("line 5", { exact: true })).toBeVisible()
})
