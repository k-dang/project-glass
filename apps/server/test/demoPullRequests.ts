import type { FakeGitHub } from "./fakeGitHub"
import { type FakeChangedFile, VIEWER } from "./fakePullRequest"

/** The repository the demo PRs live in, followed so they show in Reviews. */
export const DEMO_REPOSITORY = { owner: "octo-org", repo: "hello-world" } as const

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

/** A changed file as one hunk spanning the whole file. */
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

const seed = (
  github: FakeGitHub,
  pr: { title: string; author: string; body: string; reviewers: Array<string> },
  files: ReadonlyArray<DemoFile>,
) => {
  const commit = (side: "base" | "head") => ({
    sha: `${side}-${pr.title.toLowerCase().replaceAll(/\W+/g, "-")}`,
    files: Object.fromEntries(
      files.flatMap((file) => (file[side] === null ? [] : [[file.path, file[side]]])),
    ),
  })

  return github.seedPullRequest({
    ...DEMO_REPOSITORY,
    title: pr.title,
    author: pr.author,
    body: pr.body,
    bodyHtml: `<p>${pr.body}</p>`,
    requestedReviewers: pr.reviewers,
    base: commit("base"),
    head: commit("head"),
    changedFiles: files.map((file) => file.change),
  })
}

const rateLimit = [
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

/** A nine-file PR awaiting the viewer's review, a one-line fix, and one of the viewer's own. */
export const seedDemoPullRequests = (github: FakeGitHub) => {
  seed(
    github,
    {
      title: "Rate-limit the public API",
      author: "hubot",
      body: "Adds a per-client token bucket in front of the public API.",
      reviewers: [VIEWER.login],
    },
    rateLimit,
  )

  seed(
    github,
    {
      title: "Fix the typo in the README",
      author: "monalisa",
      body: "Hello, not Helo.",
      reviewers: [VIEWER.login],
    },
    [modified("README.md", [...remove("Helo"), ...add("Hello")])],
  )

  const health = seed(
    github,
    { title: "Add a health check", author: VIEWER.login, body: "Answers ok.", reviewers: [] },
    [added("src/health.ts", ['export const health = () => "ok"'])],
  )

  health.addReviewThread({
    path: "src/health.ts",
    line: 1,
    comments: [{ author: "hubot", bodyHtml: "<p>Does this stay this small?</p>" }],
  })
}
