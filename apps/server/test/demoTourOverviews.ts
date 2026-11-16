import { ChangedFile, TextPatch } from "@glass/contracts"
import { Predicate } from "effect"
import type { TourAnswer } from "../src/tourPrompt"
import { DEMO_REPOSITORY } from "./demoPullRequests"
import type { FakeGitHub } from "./fakeGitHub"
import { VIEWER } from "./fakePullRequest"

interface ExampleFile {
  readonly path: string
  readonly base: ReadonlyArray<string>
  readonly head: ReadonlyArray<string>
}

export interface TourOverviewExample {
  readonly title: string
  readonly files: ReadonlyArray<ExampleFile>
  readonly tour: TourAnswer
}

const target = (path: string, startLine = 1, side: "old" | "new" = "new") => ({
  path,
  side,
  startLine,
  endLine: startLine,
})

const host = "HostAgents.ts"

const runtime = "openCodeRuntime.ts"

const turns = "openCodeTurn.ts"

export const tourOverviewExamples: ReadonlyArray<TourOverviewExample> = [
  {
    title: "Tour example: add OpenCode for ordinary Agents",
    files: [
      {
        path: host,
        base: [
          "export const startAgent = (harness, adapters) => {",
          '  if (harness === "pi") return adapters.pi.start()',
          '  return adapters["claude-code"].start()',
          "}",
        ],
        head: [
          'import { openCodeAdapter } from "./openCodeRuntime"',
          "",
          "export const startAgent = (harness, adapters, openCode) => {",
          "  const harnesses = { ...adapters, opencode: openCodeAdapter(openCode) }",
          "  return harnesses[harness].start()",
          "}",
        ],
      },
      {
        path: runtime,
        base: [],
        head: [
          'import { openCodeTurn } from "./openCodeTurn"',
          "",
          "export const openCodeAdapter = ({ createService, token, toTurn }) => ({",
          "  start: () => {",
          '    const service = createService({ token, hostname: "127.0.0.1" })',
          "    return openCodeTurn(service.events, service.history, toTurn)",
          "  },",
          "})",
        ],
      },
      {
        path: turns,
        base: [],
        head: [
          "export const openCodeTurn = (events, history, toTurn) =>",
          "  toTurn([...history, ...events])",
        ],
      },
    ],
    tour: {
      intent:
        "Add an OpenCode harness path alongside Claude Code and pi, translating native events and history into Glass Turns. This hand-authored synthetic example illustrates the supplied OpenCode Tour; its small source files are demonstration code.",
      diagram: {
        nodes: [
          { id: "start", label: "Start an Agent", change: "unchanged", target: target(host, 3) },
          {
            id: "claude",
            label: "Claude Code",
            change: "unchanged",
            target: target(host, 3, "old"),
          },
          { id: "pi", label: "pi", change: "unchanged", target: target(host, 2, "old") },
          {
            id: "opencode",
            label: "OpenCode service",
            change: "added",
            target: target(runtime, 5),
          },
          {
            id: "translate",
            label: "Translate events and history",
            change: "added",
            target: target(turns),
          },
          {
            id: "turns",
            label: "Glass Agent Turns",
            change: "unchanged",
            target: target(turns, 2),
          },
        ],
        edges: [
          { from: "start", to: "claude", change: "unchanged", label: "Claude Code" },
          { from: "start", to: "pi", change: "unchanged", label: "pi" },
          { from: "start", to: "opencode", change: "added", label: "OpenCode" },
          { from: "claude", to: "turns", change: "unchanged" },
          { from: "pi", to: "turns", change: "unchanged" },
          { from: "opencode", to: "translate", change: "added", label: "native events" },
          { from: "translate", to: "turns", change: "added" },
        ],
      },
      chapters: [
        {
          title: "Start the selected harness",
          explanation:
            "The demonstration host dispatches through the selected adapter. Claude Code and pi remain choices, and OpenCode joins them. The nodes for the existing harnesses open the old side of this diff.",
          files: [{ path: host, summary: "Dispatches through the selected harness adapter." }],
        },
        {
          title: "Run the OpenCode service",
          explanation:
            "The demonstration OpenCode runtime creates a local service with an authentication token. This is the added harness path shown on the overview map.",
          files: [{ path: runtime, summary: "Starts the demonstration OpenCode service." }],
        },
        {
          title: "Turn native history into Glass Turns",
          explanation:
            "The demonstration adapter passes native events and history to the existing Turn conversion interface. Its overview node links directly to that conversion call.",
          files: [{ path: turns, summary: "Connects native events and history to Turns." }],
        },
      ],
      unplacedFiles: [],
    },
  },
  {
    title: "Tour example: validate before saving",
    files: [
      {
        path: "submit.ts",
        base: ["export const submit = (input, save) => save(input)"],
        head: [
          "export const submit = (input, validate, save) => {",
          "  const valid = validate(input)",
          "  return save(valid)",
          "}",
        ],
      },
      {
        path: "storage.ts",
        base: ["export const save = (input, db) => db.insert(input)"],
        head: ["export const save = (validInput, db) => db.insert(validInput)"],
      },
    ],
    tour: {
      intent:
        "Validate submitted input before it reaches the existing save function. This is a hand-authored synthetic Tour of a linear change; the map shows the successful path.",
      diagram: {
        nodes: [
          {
            id: "receive",
            label: "Receive fields",
            change: "unchanged",
            target: target("submit.ts"),
          },
          {
            id: "validate",
            label: "Validate input",
            change: "added",
            target: target("submit.ts", 2),
          },
          {
            id: "save",
            label: "Save the record",
            change: "unchanged",
            target: target("storage.ts"),
          },
        ],
        edges: [
          { from: "receive", to: "validate", change: "added" },
          { from: "validate", to: "save", change: "added" },
          { from: "receive", to: "save", change: "removed", label: "before: save directly" },
        ],
      },
      chapters: [
        {
          title: "Check input before saving",
          explanation:
            "The demonstration submission handler inserts validation between receiving input and saving it. The removed connection on the map shows the old path that bypassed that step.",
          files: [{ path: "submit.ts", summary: "Validates submitted input before saving." }],
        },
        {
          title: "Keep the existing save path",
          explanation:
            "Validated input reaches the same storage interface. The parameter name makes the expectation visible without adding another storage operation.",
          files: [{ path: "storage.ts", summary: "Receives validated input." }],
        },
      ],
      unplacedFiles: [],
    },
  },
  {
    title: "Tour example: group rate-limit settings",
    files: [
      {
        path: "config.json",
        base: ["{", '  "burst": 20,', '  "perSecond": 5', "}"],
        head: [
          "{",
          '  "rateLimit": {',
          '    "enabled": true,',
          '    "burst": 20,',
          '    "perSecond": 5',
          "  }",
          "}",
        ],
      },
    ],
    tour: {
      intent:
        "Group rate-limit values under one key, beside an enabled setting. This hand-authored synthetic Tour uses an outline because nesting is the change the reader needs to see.",
      beforeAfter: {
        title: "Keep the values, change their home",
        lines: [
          { depth: 0, text: "configuration", change: "unchanged", target: null },
          {
            depth: 1,
            text: "burst: 20",
            change: "removed",
            target: target("config.json", 2, "old"),
          },
          {
            depth: 1,
            text: "perSecond: 5",
            change: "removed",
            target: target("config.json", 3, "old"),
          },
          { depth: 1, text: "rateLimit", change: "added", target: target("config.json", 2) },
          { depth: 2, text: "enabled: true", change: "added", target: target("config.json", 3) },
          { depth: 2, text: "burst: 20", change: "added", target: target("config.json", 4) },
          { depth: 2, text: "perSecond: 5", change: "added", target: target("config.json", 5) },
        ],
      },
      chapters: [
        {
          title: "Group the limiter’s configuration",
          explanation:
            "The existing burst and refill values move under rateLimit. The new enabled setting sits beside them. The values themselves stay at a burst of 20 and a refill of five per second.",
          files: [{ path: "config.json", summary: "Groups rate limiting under one key." }],
        },
      ],
      unplacedFiles: [],
    },
  },
]

export const tourOverviewFiles = (example: TourOverviewExample) =>
  example.files.map(
    ({ path, base, head }) =>
      new ChangedFile({
        path,
        previousPath: null,
        changeType: base.length === 0 ? "added" : "modified",
        additions: head.length,
        deletions: base.length,
        patch: TextPatch.make({
          hunks: `@@ -${base.length === 0 ? 0 : 1},${base.length} +1,${head.length} @@\n${[...base.map((line) => `-${line}`), ...head.map((line) => `+${line}`)].join("\n")}`,
        }),
      }),
  )

export const seedTourOverviewPullRequests = (github: FakeGitHub) =>
  tourOverviewExamples.map((example, index) => {
    const files = tourOverviewFiles(example)

    return github.seedPullRequest({
      ...DEMO_REPOSITORY,
      title: example.title,
      author: "hubot",
      body: example.tour.intent,
      requestedReviewers: [VIEWER.login],
      base: {
        sha: `overview-base-${index}`,
        files: Object.fromEntries(
          example.files.flatMap((file) =>
            file.base.length > 0 ? [[file.path, `${file.base.join("\n")}\n`]] : [],
          ),
        ),
      },
      head: {
        sha: `overview-head-${index}`,
        files: Object.fromEntries(
          example.files.map((file) => [file.path, `${file.head.join("\n")}\n`]),
        ),
      },
      changedFiles: files.map((file) => ({
        path: file.path,
        status: file.changeType === "added" ? "added" : "modified",
        additions: file.additions,
        deletions: file.deletions,
        patch: Predicate.isTagged(file.patch, "TextPatch") ? file.patch.hunks : "",
      })),
    })
  })
