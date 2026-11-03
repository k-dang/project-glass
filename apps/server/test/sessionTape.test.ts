import { assert, it } from "@effect/vitest"
import { blankPersonal } from "./sessionTape"

it("blanks identity and credentials and zeros usage without changing protocol content", () => {
  assert.deepStrictEqual(
    blankPersonal({
      account: { email: "person@example.com", organizationId: "private-org" },
      apiKey: "private-key",
      sections: { skills: "Private installed skills", cwd: "/home/person" },
      usage: { input_tokens: 123, output_tokens: 45 },
      modelUsage: { haiku: { inputTokens: 123, costUSD: 0.01 } },
      total_cost_usd: 0.01,
      estimated_tokens: 45,
      model: { maxTokens: 128000, cost: { input: 0.1, output: 0.5 } },
      content: [{ type: "text", text: "DONE" }],
      index: 2,
    }),
    {
      account: "<redacted>",
      apiKey: "<redacted>",
      sections: "<redacted>",
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: { haiku: { inputTokens: 0, costUSD: 0 } },
      total_cost_usd: 0,
      estimated_tokens: 0,
      model: { maxTokens: 128000, cost: { input: 0.1, output: 0.5 } },
      content: [{ type: "text", text: "DONE" }],
      index: 2,
    },
  )
})
