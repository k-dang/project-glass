import type { FakeGitHub } from "./fakeGitHub"
import { type FakeChangedFile, type FakePullRequestSeed, VIEWER } from "./fakePullRequest"

export const DEMO_REPOSITORY = { owner: "octo-org", repo: "hello-world" } as const

export const DEMO_GATEWAY_REPOSITORY = { owner: "octo-org", repo: "api-gateway" } as const

export const RATE_LIMIT_TITLE = "Rate-limit the public API"

type Line = readonly [" " | "-" | "+", string]

const lines = (prefix: Line[0], ...texts: Array<string>) =>
  texts.map((text): Line => [prefix, text])

const keep = (...texts: Array<string>) => lines(" ", ...texts)

const remove = (...texts: Array<string>) => lines("-", ...texts)

const add = (...texts: Array<string>) => lines("+", ...texts)

const fileText = (texts: ReadonlyArray<string>) => `${texts.join("\n")}\n`

interface DemoFile {
  readonly path: string
  readonly base: string | null
  readonly head: string
  readonly change: FakeChangedFile
}

const modified = (path: string, diff: ReadonlyArray<Line>): DemoFile => {
  const base = diff.flatMap(([prefix, text]) => (prefix === "+" ? [] : [text]))
  const head = diff.flatMap(([prefix, text]) => (prefix === "-" ? [] : [text]))

  return {
    path,
    base: fileText(base),
    head: fileText(head),
    change: {
      path,
      status: "modified",
      additions: diff.filter(([prefix]) => prefix === "+").length,
      deletions: diff.filter(([prefix]) => prefix === "-").length,
      patch: `@@ -1,${base.length} +1,${head.length} @@\n${diff.map(([prefix, text]) => prefix + text).join("\n")}`,
    },
  }
}

const added = (path: string, texts: ReadonlyArray<string>): DemoFile => ({
  path,
  base: null,
  head: fileText(texts),
  change: {
    path,
    status: "added",
    additions: texts.length,
    patch: `@@ -0,0 +1,${texts.length} @@\n${texts.map((text) => `+${text}`).join("\n")}`,
  },
})

type CheckRun = readonly [name: string, conclusion: "SUCCESS" | "FAILURE" | "IN_PROGRESS"]

type DemoPullRequest = Omit<
  FakePullRequestSeed,
  "owner" | "bodyHtml" | "base" | "head" | "changedFiles" | "checks" | "checkContexts"
> & {
  readonly title: string
  readonly body: string
  readonly checkRuns?: ReadonlyArray<CheckRun>
}

const rollup = (runs: ReadonlyArray<CheckRun>) =>
  runs.some(([, conclusion]) => conclusion === "FAILURE")
    ? "FAILURE"
    : runs.some(([, conclusion]) => conclusion === "IN_PROGRESS")
      ? "PENDING"
      : "SUCCESS"

const slug = (title: string) => title.toLowerCase().replaceAll(/\W+/g, "-")

const seed = (
  github: FakeGitHub,
  { checkRuns, ...pr }: DemoPullRequest,
  files: ReadonlyArray<DemoFile>,
) => {
  const commit = (side: "base" | "head") => ({
    sha: `${side}-${slug(pr.title)}`,
    files: Object.fromEntries(
      files.flatMap((file) => (file[side] === null ? [] : [[file.path, file[side]]])),
    ),
  })

  return github.seedPullRequest({
    ...DEMO_REPOSITORY,
    headBranch: slug(pr.title),
    ...pr,
    bodyHtml: `<p>${pr.body}</p>`,
    ...(checkRuns && {
      checks: rollup(checkRuns),
      checkContexts: checkRuns.map(([name, conclusion]) => ({
        kind: "CheckRun" as const,
        name,
        workflow: "CI",
        ...(conclusion === "IN_PROGRESS"
          ? { status: "IN_PROGRESS" as const }
          : { status: "COMPLETED" as const, conclusion }),
      })),
    }),
    base: commit("base"),
    head: commit("head"),
    changedFiles: files.map((file) => file.change),
  })
}

export const rateLimitFiles = [
  modified("src/server/middleware.ts", [
    ...keep('import type { Handler, Request } from "./http"'),
    ...add('import { type Bucket, createBucket, retryAfter, take } from "../rateLimit/bucket"'),
    ...add('import type { RateLimitConfig } from "../config/schema"'),
    ...keep("", "export const logRequests = (next: Handler): Handler => async (request) => {"),
    ...keep("  const started = Date.now()", "  const response = await next(request)", ""),
    ...keep("  console.log(request.method, request.path, response.status, Date.now() - started)"),
    ...keep("", "  return response", "}", ""),
    ...remove("export const middleware = (next: Handler) => logRequests(next)"),
    ...add(
      'const clientKey = (request: Request) => request.headers.get("x-api-key") ?? request.ip',
      "",
      "export const limitRequests = (config: RateLimitConfig) => (next: Handler): Handler => {",
      "  const buckets = new Map<string, Bucket>()",
      "",
      "  return async (request) => {",
      "    const key = clientKey(request)",
      "    const now = Date.now()",
      "    const bucket = buckets.get(key) ?? createBucket(config.burst, config.perSecond, now)",
      "",
      "    buckets.set(key, bucket)",
      "",
      "    if (!take(bucket, now)) {",
      '      return new Response("Too many requests", {',
      "        status: 429,",
      '        headers: { "retry-after": String(retryAfter(bucket)) },',
      "      })",
      "    }",
      "",
      "    return next(request)",
      "  }",
      "}",
      "",
      "export const middleware = (config: RateLimitConfig) => (next: Handler) =>",
      "  logRequests(config.enabled ? limitRequests(config)(next) : next)",
    ),
  ]),
  modified("src/server/middleware.test.ts", [
    ...keep('import { expect, it } from "vitest"'),
    ...remove('import { middleware } from "./middleware"'),
    ...add('import { limitRequests, middleware } from "./middleware"'),
    ...keep('import { fakeRequest, ok } from "./testing"', ""),
    ...keep('it("passes requests through", async () => {'),
    ...remove("  const response = await middleware(ok)(fakeRequest())"),
    ...add(
      "  const config = { enabled: false, burst: 1, perSecond: 1 }",
      "  const response = await middleware(config)(ok)(fakeRequest())",
    ),
    ...keep("", "  expect(response.status).toBe(200)", "})"),
    ...add(
      "",
      'it("answers 429 with retry-after once a client runs out", async () => {',
      "  const handler = limitRequests({ enabled: true, burst: 1, perSecond: 1 })(ok)",
      "",
      '  await handler(fakeRequest({ apiKey: "a" }))',
      '  const limited = await handler(fakeRequest({ apiKey: "a" }))',
      "",
      "  expect(limited.status).toBe(429)",
      '  expect(limited.headers.get("retry-after")).toBe("1")',
      "})",
    ),
  ]),
  added("src/rateLimit/bucket.ts", [
    "export interface Bucket {",
    "  readonly capacity: number",
    "  readonly refillPerSecond: number",
    "  tokens: number",
    "  updatedAt: number",
    "}",
    "",
    "export const createBucket = (capacity: number, refillPerSecond: number, now: number): Bucket => ({",
    "  capacity,",
    "  refillPerSecond,",
    "  tokens: capacity,",
    "  updatedAt: now,",
    "})",
    "",
    "/** Refills the bucket for the time since it was last used, then takes one token if it can. */",
    "export const take = (bucket: Bucket, now: number) => {",
    "  const elapsed = (now - bucket.updatedAt) / 1000",
    "",
    "  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerSecond)",
    "  bucket.updatedAt = now",
    "",
    "  if (bucket.tokens < 1) return false",
    "",
    "  bucket.tokens -= 1",
    "",
    "  return true",
    "}",
    "",
    "export const retryAfter = (bucket: Bucket) =>",
    "  Math.ceil((1 - bucket.tokens) / bucket.refillPerSecond)",
  ]),
  added("src/rateLimit/bucket.test.ts", [
    'import { expect, it } from "vitest"',
    'import { createBucket, take } from "./bucket"',
    "",
    'it("allows a burst up to capacity", () => {',
    "  const bucket = createBucket(2, 1, 0)",
    "",
    "  expect([take(bucket, 0), take(bucket, 0), take(bucket, 0)]).toEqual([true, true, false])",
    "})",
    "",
    'it("refills over time", () => {',
    "  const bucket = createBucket(1, 2, 0)",
    "",
    "  take(bucket, 0)",
    "  expect(take(bucket, 250)).toBe(false)",
    "  expect(take(bucket, 500)).toBe(true)",
    "})",
  ]),
  modified("src/config/schema.ts", [
    ...keep('import { z } from "zod"', ""),
    ...add(
      "export const RateLimitConfig = z.object({",
      "  enabled: z.boolean(),",
      "  burst: z.number().int().positive(),",
      "  perSecond: z.number().positive(),",
      "})",
      "",
      "export type RateLimitConfig = z.infer<typeof RateLimitConfig>",
      "",
    ),
    ...keep("export const Config = z.object({", "  port: z.number().int(),"),
    ...keep("  databaseUrl: z.string().url(),"),
    ...add("  rateLimit: RateLimitConfig,"),
    ...keep("})", "", "export type Config = z.infer<typeof Config>"),
  ]),
  modified("config/default.json", [
    ...keep("{", '  "port": 8080,'),
    ...remove('  "databaseUrl": "postgres://localhost/app"'),
    ...add(
      '  "databaseUrl": "postgres://localhost/app",',
      '  "rateLimit": { "enabled": true, "burst": 20, "perSecond": 5 }',
    ),
    ...keep("}"),
  ]),
  added("docs/rate-limits.md", [
    "# Rate limits",
    "",
    "The public API allows each client a burst of 20 requests, refilled at 5 per second.",
    "Clients are told apart by their `x-api-key` header, or by IP address without one.",
    "",
    "A client over its limit gets `429 Too many requests` with a `retry-after` header.",
  ]),
  modified("CHANGELOG.md", [
    ...keep("# Changelog", ""),
    ...add("## 1.5.0", "", "- Rate-limit the public API per client.", ""),
    ...keep("## 1.4.0", "", "- Log request durations."),
  ]),
  modified("package.json", [
    ...keep("{", '  "name": "public-api",'),
    ...remove('  "version": "1.4.0",'),
    ...add('  "version": "1.5.0",'),
    ...keep('  "type": "module"', "}"),
  ]),
]

export const seedDemoPullRequests = (github: FakeGitHub) => {
  const rateLimit = seed(
    github,
    {
      title: RATE_LIMIT_TITLE,
      author: "hubot",
      body: "Adds a per-client token bucket in front of the public API.",
      requestedReviewers: [VIEWER.login],
      checkRuns: [
        ["build", "SUCCESS"],
        ["lint", "SUCCESS"],
        ["test", "IN_PROGRESS"],
      ],
    },
    rateLimitFiles,
  )

  rateLimit.addComment({
    author: "monalisa",
    bodyHtml: "<p>Can we ship this behind the flag first and turn it on per environment?</p>",
  })

  const proxyThread = rateLimit.addReviewThread({
    path: "src/server/middleware.ts",
    line: 14,
    resolved: true,
    comments: [
      {
        author: "monalisa",
        bodyHtml: "<p>Behind the load balancer every client shares one IP.</p>",
      },
      {
        author: "hubot",
        bodyHtml: "<p>The gateway sets <code>request.ip</code> from the forwarded header.</p>",
      },
    ],
  })

  rateLimit.react(proxyThread.comments[1]!.id, "THUMBS_UP", "monalisa")

  rateLimit.addReview({
    author: "monalisa",
    state: "COMMENTED",
    bodyHtml: "<p>Looks right to me; one question on the proxy case.</p>",
  })

  const readme = modified("README.md", [...remove("Helo"), ...add("Hello")])

  seed(
    github,
    {
      title: "Fix the typo in the README",
      author: "monalisa",
      body: "Hello, not Helo.",
      requestedReviewers: [VIEWER.login],
      checkRuns: [["build", "SUCCESS"]],
      pendingReview: {
        drafts: [
          {
            path: "README.md",
            line: 1,
            side: "RIGHT",
            body: "Could this say Hello, world?",
            diffHunk: readme.change.patch!,
          },
        ],
      },
    },
    [readme],
  )

  const health = seed(
    github,
    { title: "Add a health check", author: VIEWER.login, body: "Answers ok." },
    [added("src/health.ts", ['export const health = () => "ok"'])],
  )

  health.addReviewThread({
    path: "src/health.ts",
    line: 1,
    comments: [{ author: "hubot", bodyHtml: "<p>Does this stay this small?</p>" }],
  })

  const retries = seed(
    github,
    {
      title: "Retry failed webhook deliveries",
      author: VIEWER.login,
      body: "Retries a failed delivery up to three times.",
      reviewDecision: "CHANGES_REQUESTED",
      checkRuns: [
        ["build", "SUCCESS"],
        ["test", "FAILURE"],
      ],
    },
    [
      modified("src/webhooks/deliver.ts", [
        ...keep("export const deliver = async (url: string, body: string) => {"),
        ...remove('  await fetch(url, { method: "POST", body })'),
        ...add(
          "  for (let attempt = 1; attempt <= 3; attempt++) {",
          '    const response = await fetch(url, { method: "POST", body })',
          "",
          "    if (response.ok) return",
          "  }",
        ),
        ...keep("}"),
      ]),
    ],
  )

  retries.addReview({
    author: "monalisa",
    state: "CHANGES_REQUESTED",
    bodyHtml: "<p>Back off between attempts, or a down receiver gets three requests at once.</p>",
  })

  const slowQueries = seed(
    github,
    {
      title: "Log slow database queries",
      author: VIEWER.login,
      body: "Logs any query slower than 500 ms.",
      reviewDecision: "APPROVED",
      checkRuns: [
        ["build", "SUCCESS"],
        ["test", "SUCCESS"],
      ],
    },
    [
      added("src/database/slowQueries.ts", [
        "export const slowQueryMs = 500",
        "",
        "export const logIfSlow = (sql: string, ms: number) => {",
        "  if (ms > slowQueryMs) console.warn(`Slow query (${ms} ms): ${sql}`)",
        "}",
      ]),
    ],
  )

  slowQueries.addReview({ author: "hubot", state: "APPROVED", bodyHtml: "<p>Ship it.</p>" })

  seed(
    github,
    {
      title: "Sketch a dark mode toggle",
      author: VIEWER.login,
      body: "Not ready: the toggle doesn't persist yet.",
      isDraft: true,
      checkRuns: [["build", "IN_PROGRESS"]],
    },
    [
      added("src/ui/darkMode.ts", [
        "export const toggleDarkMode = () =>",
        '  document.documentElement.classList.toggle("dark")',
      ]),
    ],
  )

  seed(
    github,
    {
      ...DEMO_GATEWAY_REPOSITORY,
      title: "Cache upstream responses",
      author: "monalisa",
      body: "Caches GET responses for the time their cache-control header allows.",
      requestedTeams: VIEWER.teams,
      checkRuns: [["build", "SUCCESS"]],
    },
    [
      modified("src/proxy.ts", [
        ...keep("export const proxy = async (request: Request) => {"),
        ...add(
          '  const cache = await caches.open("upstream")',
          "  const cached = await cache.match(request)",
          "",
          "  if (cached) return cached",
          "",
        ),
        ...keep("  return fetch(request)", "}"),
      ]),
    ],
  )
}
