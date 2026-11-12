import type { AgentReviewAnswer } from "../src/agentReviewPrompt"

const middleware = "src/server/middleware.ts"

export const demoAgentReview: AgentReviewAnswer = {
  markdown: [
    "**An unverified `x-api-key` lets any client skip the limit.** The PR puts a per-client token bucket in front of the public API and returns 429 with `retry-after` when a client runs out. The client key, the newly required config, and the in-memory buckets carry the risk; the rest is wiring. This is a curated synthetic Agent review, written without a model.",
    "## Minor",
    "- `retryAfter` rounds up from fractional tokens, so a client told to wait 1 second may still find the bucket empty after a refill race.\n- `bucket.test.ts` doesn't cover a refill that would pass capacity.",
  ].join("\n\n"),
  hotspots: [
    {
      title: "Any caller can mint a fresh bucket",
      kind: "auth",
      place: { path: middleware, side: "new", startLine: 14, endLine: 24 },
      why: "`clientKey` trusts `x-api-key` without checking it, and `limitRequests` creates a bucket for every new key. A client that sends a different header on each request is never limited, and `buckets` grows without bound. Blocking.",
      evidence: 'request.headers.get("x-api-key") ?? request.ip, then buckets.set(key, bucket)',
      check:
        "Is the key verified before it picks a bucket? Is there an eviction or size cap on `buckets`?",
    },
    {
      title: "`rateLimit` is now required in every config",
      kind: "public-contract",
      place: { path: "src/config/schema.ts", side: "new", startLine: 11, endLine: 15 },
      why: "`Config` now requires `rateLimit`, but only `config/default.json` gains it, so any deployed config without the key fails to parse at boot. `middleware(next)` also became `middleware(config)(next)`. Should fix.",
      evidence: "rateLimit: RateLimitConfig,",
      check:
        "Do the other environments' configs set `rateLimit`? Should it be optional with defaults? Does anything outside this PR call `middleware`?",
    },
    {
      title: "Limits are per process, not per client",
      kind: "concurrency",
      place: { path: middleware, side: "new", startLine: 17, endLine: 17 },
      why: "`buckets` lives in each server process's memory. With several instances behind a load balancer, a client gets that many times the documented burst of 20. Should fix.",
      evidence: "const buckets = new Map<string, Bucket>()",
      check:
        "How many instances serve the public API? Should `docs/rate-limits.md` say the limit is per instance?",
    },
  ],
  lowAttention: [
    { path: "config/default.json", reason: "Default values for the new config" },
    { path: "docs/rate-limits.md", reason: "Docs that describe the change" },
    { path: "CHANGELOG.md", reason: "Release note" },
    { path: "package.json", reason: "Version bump" },
  ],
}
