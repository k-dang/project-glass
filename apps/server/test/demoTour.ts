import type { TourCodeTarget } from "@glass/contracts"
import type { TourAnswer } from "../src/tourPrompt"
import { rateLimitFiles } from "./demoPullRequests"

const middleware = "src/server/middleware.ts"

const bucket = "src/rateLimit/bucket.ts"

const bucketTest = "src/rateLimit/bucket.test.ts"

const target = (path: string, marker: string, side: "old" | "new" = "new"): TourCodeTarget => {
  const file = rateLimitFiles.find((entry) => entry.path === path)!
  const text = side === "old" ? file.base! : file.head
  const line = text.split("\n").findIndex((sourceLine) => sourceLine.includes(marker)) + 1

  return { path, side, startLine: line, endLine: line }
}

export const demoTour: TourAnswer = {
  intent:
    "Give each API client a token bucket, returning 429 when its tokens run out. This is a curated synthetic Tour, written without a model.",
  beforeAfter: {
    title: "What happens to a request",
    lines: [
      { depth: 0, text: "request arrives", change: "unchanged", target: null },
      {
        depth: 1,
        text: "log it and call the handler",
        change: "removed",
        target: target(middleware, "export const middleware", "old"),
      },
      {
        depth: 1,
        text: "log it, then find the client's bucket",
        change: "added",
        target: target(middleware, "buckets.get(key)"),
      },
      {
        depth: 2,
        text: "no token left: return 429 with retry-after",
        change: "added",
        target: target(middleware, "status: 429"),
      },
      {
        depth: 2,
        text: "token taken: call the handler",
        change: "added",
        target: target(middleware, "return next(request)"),
      },
    ],
  },
  chapters: [
    {
      title: "Gate requests before the handler",
      explanation:
        "Previously, middleware only logged requests. When rate limiting is enabled, it now looks up a bucket by API key or IP address and takes a token before calling the handler. An empty bucket returns 429 with a retry-after header. This is the closest read: the new gate decides whether the handler runs.",
      files: [
        { path: middleware, summary: "Adds a per-client gate inside the request logger." },
        {
          path: "src/server/middleware.test.ts",
          summary: "Exercises rejection and the disabled limiter.",
        },
      ],
      diagram: [
        "flowchart LR",
        "  request[Request arrives] --> gate[Enable the request gate]:::added",
        "  request -.-> forward[Call the request handler]",
        "  gate --> lookup[Find the client's bucket]:::added",
        "  lookup --> take[Try to take one token]:::added",
        "  take -->|token taken| forward",
        "  take -->|no token left| reject[Return 429 and retry-after]:::added",
      ].join("\n"),
      callouts: [
        {
          label: "An API key identifies the client; requests without one use their IP address.",
          target: target(middleware, "const clientKey"),
        },
        {
          label: "Disabling the limiter keeps the handler inside the existing request logger.",
          target: target(middleware, "logRequests(config.enabled"),
        },
      ],
    },
    {
      title: "Refill and consume tokens",
      explanation:
        "Each bucket starts full. Taking a token first refills it for the elapsed time, capped at capacity, then consumes one only when at least one is available. The Before / after follows the burst test into the implementation. The tests cover burst capacity and fractional refill intervals.",
      files: [
        { path: bucket, summary: "Tracks tokens, refills over time, and calculates retry delays." },
        { path: bucketTest, summary: "Covers burst capacity and time-based refill." },
      ],
      beforeAfter: {
        title: "A burst of three requests",
        lines: [
          {
            depth: 0,
            text: "test a burst of three requests",
            change: "added",
            target: target(bucketTest, 'it("allows a burst'),
          },
          {
            depth: 1,
            text: "createBucket: start with two tokens",
            change: "added",
            target: target(bucket, "export const createBucket"),
          },
          {
            depth: 1,
            text: "take: allow two requests, reject the third",
            change: "added",
            target: target(bucket, "export const take"),
          },
        ],
      },
      callouts: [
        {
          label: "Refill cannot exceed the bucket's capacity.",
          target: target(bucket, "bucket.tokens = Math.min"),
        },
      ],
    },
    {
      title: "Ship the defaults and documentation",
      explanation:
        "Configuration enables the limiter with a burst of 20 requests and a refill of five tokens per second. The schema exposes those settings, the docs describe client identity and 429 responses, and the changelog and package version announce the release.",
      files: [
        { path: "src/config/schema.ts", summary: "Adds the rate-limit configuration fields." },
        { path: "config/default.json", summary: "Enables a 20-token burst and five-token refill." },
        { path: "docs/rate-limits.md", summary: "Documents client identity and retry behavior." },
        { path: "CHANGELOG.md", summary: "Announces rate limiting in version 1.5.0." },
        { path: "package.json", summary: "Bumps the package version to 1.5.0." },
      ],
    },
  ],
  unplacedFiles: [],
}
