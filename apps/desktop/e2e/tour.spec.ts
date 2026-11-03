import type { Page } from "@playwright/test"
import type { TourAnswer } from "../../server/src/tourPrompt"
import type { FakeGitHub } from "../../server/test/fakeGitHub"
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

test.slow()

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

test("reads linked visuals and plays flows without changing viewed progress", async ({
  github,
  claude,
  window,
}, testInfo) => {
  testInfo.setTimeout(90_000)
  await window.setViewportSize({ width: 1400, height: 1100 })
  const before = ["async function handle(input) {", "  return save(input)", "}"]

  const after = [
    before[0]!,
    "  const problem = validate(input)",
    "  if (problem) return { status: 400 }",
    before[1]!,
    "}",
  ]

  const validation = [
    "export function validate(input) {",
    '  return input.name ? null : "Name required"',
    "}",
  ]

  const pr = github.seedPullRequest({
    title: "Validate before writing",
    base: { sha: "b0", files: { "handler.ts": `${before.join("\n")}\n` } },
    head: {
      sha: "h1",
      files: { "handler.ts": `${after.join("\n")}\n`, "validate.ts": `${validation.join("\n")}\n` },
    },
    changedFiles: [
      {
        path: "handler.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        patch:
          "@@ -1,3 +1,5 @@\n async function handle(input) {\n+  const problem = validate(input)\n+  if (problem) return { status: 400 }\n   return save(input)\n }",
      },
      { path: "validate.ts", status: "added", additions: 3, patch: added(validation) },
    ],
  })

  const answer: TourAnswer = {
    intent: "Reject invalid input before storage.",
    chapters: [
      {
        title: "Validate before writing",
        explanation:
          "Input is now checked before storage. Invalid requests return early, so they never reach the write.",
        files: [
          { path: "handler.ts", summary: "Checks input before saving." },
          { path: "validate.ts", summary: "Requires a name." },
        ],
        callouts: [
          {
            label: "Invalid input returns before the write.",
            target: { path: "handler.ts", side: "new", startLine: 2, endLine: 3 },
          },
        ],
        callTree: [
          {
            id: "handle",
            parent: null,
            label: "handle(input)",
            change: "unchanged",
            target: { path: "handler.ts", side: "new", startLine: 1, endLine: 1 },
          },
          {
            id: "validate",
            parent: "handle",
            label: "validate(input)",
            change: "added",
            target: { path: "validate.ts", side: "new", startLine: 1, endLine: 3 },
          },
          {
            id: "save",
            parent: "handle",
            label: "save(input)",
            change: "unchanged",
            target: { path: "handler.ts", side: "new", startLine: 4, endLine: 4 },
          },
        ],
        diagram: {
          nodes: [
            {
              id: "receive",
              label: "Receive request",
              change: "unchanged",
              target: { path: "handler.ts", side: "new", startLine: 1, endLine: 1 },
            },
            {
              id: "direct",
              label: "Write immediately",
              change: "removed",
              target: { path: "handler.ts", side: "old", startLine: 2, endLine: 2 },
            },
            {
              id: "validate",
              label: "Check input",
              change: "added",
              target: { path: "validate.ts", side: "new", startLine: 1, endLine: 3 },
            },
            {
              id: "save",
              label: "Save valid input",
              change: "unchanged",
              target: { path: "handler.ts", side: "new", startLine: 4, endLine: 4 },
            },
          ],
          edges: [
            { from: "receive", to: "direct", change: "removed" },
            { from: "receive", to: "validate", change: "added" },
            { from: "validate", to: "save", change: "added" },
          ],
          steps: [
            {
              caption: "The handler receives input.",
              nodes: ["receive"],
              edges: [],
              stateChanges: [],
            },
            {
              caption: "Validation checks the name before storage.",
              nodes: ["validate"],
              edges: [1],
              stateChanges: [{ label: "Input", before: "unchecked", after: "validated" }],
            },
            {
              caption: "Only valid input reaches the write.",
              nodes: ["save"],
              edges: [2],
              stateChanges: [],
            },
          ],
        },
      },
    ],
    unplacedFiles: [],
  }

  await claude.answer(answer)
  await openPullRequest(window, pr)
  await writeTour(window)
  const chapter = window.getByRole("region", { name: "Validate before writing", exact: true })

  const diagram = chapter.getByRole("figure", {
    name: "Change diagram for Validate before writing",
  })

  await expect(diagram).toBeVisible()
  await window.screenshot({ path: testInfo.outputPath("diagram-before.png") })

  const callouts = chapter.getByRole("navigation", {
    name: "Code callouts for Validate before writing",
  })

  await callouts.getByRole("button", { name: /Invalid input returns/ }).click()
  await expect(
    chapter.locator("[data-selected-line]").filter({ hasText: "if (problem)" }),
  ).toBeVisible()

  const flow = diagram.getByRole("group", { name: "Flow playback" })
  await flow.getByRole("button", { name: "Next flow step" }).click()
  await expect(flow).toContainText("The handler receives input.")
  await flow.getByRole("button", { name: "Next flow step" }).click()
  await expect(flow).toContainText("Validation checks the name before storage.")
  await expect(flow).toContainText("unchecked → validated")
  await chapter.getByRole("button", { name: "Expand diagram", exact: true }).click()
  const collapse = chapter.getByRole("button", { name: "Collapse diagram", exact: true })
  await expect(collapse).toBeFocused()
  await expect(collapse).toHaveAttribute("aria-expanded", "true")
  await expect(flow).toContainText("unchecked → validated")
  await expect
    .poll(() =>
      chapter.evaluate((element) => {
        const figure = element.querySelector("figure")!.getBoundingClientRect()

        const nodes = [...element.querySelectorAll("[data-diagram-node]")].map((node) =>
          node.getBoundingClientRect(),
        )

        const explanation = element.querySelector("aside")!.getBoundingClientRect()
        const diff = element.querySelector("aside")!.nextElementSibling!.getBoundingClientRect()

        return {
          wide: figure.width > element.clientWidth * 0.85,
          horizontal: nodes.every((node) => Math.abs(node.top - nodes[0]!.top) < 1),
          stacked: diff.top >= explanation.bottom,
        }
      }),
    )
    .toEqual({ wide: true, horizontal: true, stacked: true })
  await window.screenshot({ path: testInfo.outputPath("diagram-expanded.png") })
  await flow.getByRole("button", { name: "Next flow step" }).click()
  await expect(flow.getByRole("button", { name: "Next flow step" })).toBeDisabled()
  await flow.getByRole("button", { name: "Previous flow step" }).click()
  await flow.getByRole("button", { name: "Play flow" }).click()
  await expect(flow).toContainText("Only valid input reaches the write.")
  await expect(flow.getByRole("button", { name: "Play flow" })).toBeVisible()
  await flow.getByRole("button", { name: "Play flow" }).click()
  await flow.getByRole("button", { name: "Pause flow" }).click()
  await expect(flow.getByRole("button", { name: "Play flow" })).toBeVisible()
  await window.screenshot({ path: testInfo.outputPath("flow-playback.png") })

  await flow.getByRole("button", { name: "Play flow" }).click()
  await window.getByRole("tab", { name: "Overview", exact: true }).click()
  await expect(window.getByRole("tabpanel", { name: "Overview", exact: true })).toBeVisible()
  await window.getByRole("tab", { name: "Changes", exact: true }).click()
  await expect(flow.getByRole("button", { name: "Play flow" })).toBeVisible()
  await chapter.getByRole("button", { name: "Expand diagram", exact: true }).focus()
  await window.keyboard.press("Enter")

  await diagram.getByRole("button", { name: /^Write immediately,/ }).click()
  await expect(
    chapter.locator("[data-selected-line]").filter({ hasText: "return save(input)" }),
  ).toBeVisible()
  const check = diagram.getByRole("button", { name: /^Check input,/ })
  await check.focus()
  await window.keyboard.press("Enter")
  await expect(check).toHaveAttribute("aria-pressed", "true")
  await expect(
    chapter.locator("[data-selected-line]").filter({ hasText: "export function validate(input)" }),
  ).toBeVisible()
  await expect(
    chapter.locator("[data-selected-line]").filter({ hasText: "Name required" }),
  ).toBeVisible()
  await expect(chapter).toContainText("0/2 viewed")
  await window.screenshot({ path: testInfo.outputPath("diagram-selected.png") })
  const caption = await flow.locator("p").innerText()
  await collapse.click()
  await expect(chapter.getByRole("button", { name: "Expand diagram", exact: true })).toBeFocused()
  await expect(check).toHaveAttribute("aria-pressed", "true")
  await expect(flow).toContainText(caption)

  await chapter.getByRole("checkbox", { name: "Viewed: validate.ts", exact: true }).click()
  await expect(chapter.getByRole("button", { name: "Show validate.ts", exact: true })).toBeVisible()
  await check.click()
  await expect(chapter.getByRole("button", { name: "Hide validate.ts", exact: true })).toBeVisible()
  await expect(chapter).toContainText("1/2 viewed")

  const tree = chapter.getByRole("region", { name: "Call tree for Validate before writing" })
  await tree.getByRole("button", { name: /validate\(input\)/ }).click()
  await expect(
    chapter.locator("[data-selected-line]").filter({ hasText: "export function validate(input)" }),
  ).toBeVisible()
  await tree.getByRole("button", { name: "Collapse calls from handle(input)" }).click()
  await expect(tree.getByRole("button", { name: /validate\(input\)/ })).toHaveCount(0)
  await chapter.getByRole("button", { name: "Expand diagram", exact: true }).click()
  await expect(tree.getByRole("button", { name: /validate\(input\)/ })).toHaveCount(0)
  await tree.getByRole("button", { name: "Expand calls from handle(input)" }).click()
  await expect(tree.getByRole("button", { name: /validate\(input\)/ })).toBeVisible()
  await window.screenshot({ path: testInfo.outputPath("call-tree.png") })

  await window.setViewportSize({ width: 800, height: 1000 })
  await expect(diagram).toBeVisible()

  const positions = await chapter.evaluate((element) => {
    const figure = element.querySelector("figure")!.getBoundingClientRect()
    const diff = element.querySelector("aside")!.nextElementSibling!.getBoundingClientRect()

    return { stacked: diff.top >= figure.bottom, fits: element.scrollWidth <= element.clientWidth }
  })

  expect(positions).toEqual({ stacked: true, fits: true })
  const nodes = diagram.locator("[data-diagram-node]")
  const first = await nodes.nth(0).boundingBox()
  const second = await nodes.nth(1).boundingBox()
  expect(second!.y).toBeGreaterThan(first!.y)
  await window.screenshot({ path: testInfo.outputPath("diagram-narrow.png") })
  await collapse.click()
  await expect(chapter).toContainText("1/2 viewed")
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

test("keeps a viewed Chapter's row in view above the next Chapter", async ({
  github,
  claude,
  window,
}) => {
  await claude.answer(tour)
  await openPullRequest(window, seedTourPullRequest(github))
  await writeTour(window)

  const changes = window.getByRole("tabpanel", { name: "Changes" })
  const first = changes.getByRole("region", { name: "Spell out the greeting" })
  await first.getByRole("checkbox", { name: "Chapter viewed: Spell out the greeting" }).click()

  await expect(first.getByRole("button", { expanded: false })).toBeInViewport()
  await expect(changes.getByRole("heading", { name: "Document the greeting" })).toBeInViewport()
})

test("moves on to the next unviewed file once a file is viewed", async ({
  github,
  claude,
  window,
}) => {
  await claude.answer(tour)
  await openPullRequest(window, seedTourPullRequest(github))
  await writeTour(window)

  const first = window
    .getByRole("tabpanel", { name: "Changes" })
    .getByRole("region", { name: "Spell out the greeting" })

  await first.getByRole("checkbox", { name: "Viewed: greet.ts", exact: true }).click()

  await expect(
    first.getByRole("button", { name: "Show greet.ts", exact: true }),
  ).not.toBeInViewport()
  await expect(first.getByRole("button", { name: "Hide big.ts", exact: true })).toBeInViewport()
  await expect(
    first.getByRole("navigation", { name: /^Files in/ }).getByRole("button", { name: /big.ts/ }),
  ).toHaveAttribute("aria-current", "location")
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

  await changes.getByRole("checkbox", { name: "Chapter viewed: Spell out the greeting" }).click()
  await window.getByRole("tab", { name: "Overview", exact: true }).click()
  await window
    .getByRole("tabpanel", { name: "Overview", exact: true })
    .getByRole("button", { name: "greet.ts", exact: true })
    .click()
  await expect(changes).toBeVisible()
  await expect(changes.getByRole("button", { name: "Hide greet.ts", exact: true })).toBeVisible()
  await expect(
    changes.locator("[data-selected-line]").filter({ hasText: "line twenty" }),
  ).toBeVisible()
  await expect(
    changes.getByRole("checkbox", { name: "Viewed: greet.ts", exact: true }),
  ).toBeChecked()

  await expect(changes.getByText("line 5", { exact: true })).toHaveCount(0)
  await changes.locator("[data-expand-button]").first().click()
  await expect(changes.getByText("line 5", { exact: true })).toBeVisible()
})
