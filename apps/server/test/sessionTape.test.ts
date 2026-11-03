import { assert, it } from "@effect/vitest"
import { blankPersonal } from "./sessionTape"

it("blanks identity and credentials and zeros usage without changing protocol content", () => {
  assert.deepStrictEqual(
    blankPersonal({
      account: { email: "person@example.com", organizationId: "private-org" },
      apiKey: "private-key",
      usage: { input_tokens: 123, output_tokens: 45 },
      modelUsage: { haiku: { inputTokens: 123, costUSD: 0.01 } },
      total_cost_usd: 0.01,
      estimated_tokens: 45,
      content: [{ type: "text", text: "DONE" }],
      index: 2,
    }),
    {
      account: "<redacted>",
      apiKey: "<redacted>",
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: { haiku: { inputTokens: 0, costUSD: 0 } },
      total_cost_usd: 0,
      estimated_tokens: 0,
      content: [{ type: "text", text: "DONE" }],
      index: 2,
    },
  )
})
