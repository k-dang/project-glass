import { tester } from "./rule-tester.ts"
import { requireSafetyCommentForTypeAssertionRule } from "../rules/require-safety-comment-for-type-assertion.ts"
import { noChainedTypeAssertionsRule } from "../rules/no-chained-type-assertions.ts"
import { noWidenThenAssertRule } from "../rules/no-widen-then-assert.ts"
import { noKnownValueWideningRule } from "../rules/no-known-value-widening.ts"

tester.run("require-safety-comment-for-type-assertion", requireSafetyCommentForTypeAssertionRule, {
  valid: [
    "const value = { kind: 'ready' } as const;",
    "const value = <const>{ kind: 'ready' };",
    "const value = input satisfies Payload;",
    "// SAFETY: The decoder checked the payload.\nconst value = input as Payload;",
    "const value = /* SAFETY: The decoder checked the payload. */ <Payload>input;",
    "// SAFETY: The decoder checked the payload.\nexport const value = input as Payload;",
    "function read() {\n// SAFETY: Checked at the boundary.\nreturn input as Payload;\n}",
    "class Reader {\n// SAFETY: Checked at the boundary.\nvalue = input as Payload;\n}",
    {
      name: "custom markers escape regex metacharacters",
      code: "// CHECK[OK]: Validated by the decoder.\nconst value = input as Payload;",
      options: [{ markers: ["CHECK[OK]"] }],
    },
  ],
  invalid: [
    {
      code: "const value = input as Payload;",
      errors: [
        {
          messageId: "missingSafetyComment",
          data: { marker: "SAFETY" },
          line: 1,
          column: 14,
          endColumn: 30,
        },
      ],
      output: null,
    },
    ...[
      "const value = <Payload>input;",
      "// SAFETY:\nconst value = input as Payload;",
      "// UNSAFETY: Not a marker.\nconst value = input as Payload;",
      "// SAFETY: Explains only the first statement.\nconst first = input as Payload;\nconst second = input as Payload;",
      "const value = input as Payload; // SAFETY: Too late.",
      "// SAFETY: Does not justify assertions inside the function.\nfunction read() { return input as Payload; }",
    ].map((code) => ({ code, errors: [{ messageId: "missingSafetyComment" }], output: null })),
    {
      name: "each assertion in a multi-binding declaration needs justification",
      code: "const first = /* SAFETY: Checked first. */ input as Payload, second = other as Payload;",
      errors: [{ messageId: "missingSafetyComment" }],
      output: null,
    },
    {
      name: "custom marker configuration does not leak between files",
      code: "// CHECK[OK]: Only valid with custom options.\nconst value = input as Payload;",
      errors: [{ messageId: "missingSafetyComment", data: { marker: "SAFETY" } }],
      output: null,
    },
  ],
})

tester.run("no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: [
    "const value = input as Payload;",
    "const value = { kind: 'ready' } as const;",
    "const value = (input as const) as const;",
    "const value = consume(input as Payload) as Result;",
  ],
  invalid: [
    "const value = input as unknown as Payload;",
    "const value = ((input as unknown)) as Payload;",
    "const value = <Payload>(<unknown>input);",
    "const value = (<unknown>input) as Payload;",
    "const value = (input as const) as Payload;",
    "// SAFETY: A comment cannot permit a chain.\nconst value = input as any as unknown as Payload;",
  ].map((code) => ({ code, errors: [{ messageId: "chained" }], output: null })),
})

tester.run("no-widen-then-assert", noWidenThenAssertRule, {
  valid: [
    "const value: unknown = readBoundary(); const result = value as Payload;",
    "const value: Payload = readBoundary(); const result = value as Payload;",
    "let value: unknown = { id: 1 }; value = readBoundary(); const result = value as Payload;",
    "const value: unknown = { id: 1 }; function read(value: unknown) { return value as Payload; }",
    "const value: unknown = { id: 1 }; function read() { return value as Payload; }",
  ],
  invalid: [
    "const value: unknown = { id: 1 }; const result = value as Payload;",
    "const original = { id: 1 }; const alias = original; const value: unknown = alias; const result = <Payload>value;",
    "const value = { id: 1 } as object; const result = value as { id: number };",
    "const value: Readonly<Record<string, unknown>> = { id: 1 }; const result = value as Record<string, number>;",
  ].map((code) => ({
    code,
    errors: [{ messageId: "widenThenAssert", data: { name: "value" } }],
    output: null,
  })),
})

tester.run("no-known-value-widening", noKnownValueWideningRule, {
  valid: [
    "const value = { id: 1 } satisfies Payload;",
    "const value: Payload = { id: 1 };",
    "const value: Record<string, unknown> = {};",
    "import type { Boundary } from './boundary'; const value: Boundary = { id: 1 };",
    "type Boundary = unknown; function read<Boundary>(value: Boundary) { const result: Boundary = value; }",
  ],
  invalid: [
    "const value = { id: 1 } as unknown;",
    "const value = <unknown>{ id: 1 };",
    "type Boundary = unknown; const value: Boundary = { id: 1 };",
    "type Boundary<T = unknown> = Record<string, T>; const value: Boundary = { id: 1 };",
    "const original = { id: 1 }; const alias = original; const value: unknown = alias;",
  ].map((code) => ({ code, errors: [{ messageId: "widening" }], output: null })),
})
