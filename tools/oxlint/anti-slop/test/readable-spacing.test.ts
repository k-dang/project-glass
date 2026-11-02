import { tester } from "./rule-tester.ts"
import { requireReadableSpacingRule } from "../rules/require-readable-spacing.ts"
import { spacingFixes } from "./spacing-fixtures.ts"

tester.run("require-readable-spacing", requireReadableSpacingRule, {
  valid: [
    ...spacingFixes.map(({ name, output }) => ({ name: `stable: ${name}`, code: output })),
    "function read() {\n  const first = 1;\n  const second = 2;\n\n\n  return first + second;\n}",
    "import { a } from 'a';\nimport { b } from 'b';\n",
  ],
  invalid: spacingFixes,
})
