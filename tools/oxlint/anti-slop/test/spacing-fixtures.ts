export const spacingFixes = [
  {
    name: "keep trailing comments with the prior statement and JSDoc with the declaration",
    code: "const count = 1; // initial count\n/** Read the count. */\nexport function read() {\n  const value = count;\n  return value;\n}\n",
    output:
      "const count = 1; // initial count\n\n/** Read the count. */\nexport function read() {\n  const value = count;\n\n  return value;\n}\n",
    errors: [
      { messageId: "expectedBlankLine", line: 3 },
      { messageId: "expectedBlankLine", line: 5 },
    ],
  },
  {
    name: "semicolon-free ASI-sensitive expression and comments retain meaning",
    code: "export function run() {\n  const value = read()\n  // Keep the ASI guard.\n  ;[value].forEach(consume)\n  return value\n}\n",
    output:
      "export function run() {\n  const value = read()\n\n  // Keep the ASI guard.\n  ;[value].forEach(consume)\n\n  return value\n}\n",
    errors: [{ messageId: "expectedBlankLine" }, { messageId: "expectedBlankLine" }],
  },
  {
    name: "same-line statements preserve semicolons and block comments",
    code: "function read() { const value = input; /* checked */ return value; }",
    output: "function read() { const value = input; /* checked */\n\n return value; }",
    errors: [{ messageId: "expectedBlankLine" }],
  },
  {
    name: "imports and overloads stay grouped while exports separate",
    code: "import { a } from 'a';\nimport { b } from 'b';\nexport function read(value: string): string;\nexport function read(value: number): number;\nexport function read(value: string | number) {\n  return value;\n}\nexport const result = read(a);\n",
    output:
      "import { a } from 'a';\nimport { b } from 'b';\n\nexport function read(value: string): string;\nexport function read(value: number): number;\nexport function read(value: string | number) {\n  return value;\n}\n\nexport const result = read(a);\n",
    errors: [{ messageId: "expectedBlankLine" }, { messageId: "expectedBlankLine" }],
  },
  {
    name: "Effect generators keep short bindings together and separate control flow",
    code: "const task = Effect.gen(function*() {\n  const first = yield* read();\n  const second = yield* read();\n  if (first) {\n    yield* write(second);\n  }\n  return second;\n});",
    output:
      "const task = Effect.gen(function*() {\n  const first = yield* read();\n  const second = yield* read();\n\n  if (first) {\n    yield* write(second);\n  }\n\n  return second;\n});",
    errors: [{ messageId: "expectedBlankLine" }, { messageId: "expectedBlankLine" }],
  },
  {
    name: "CRLF comments and line endings survive insertion",
    code: "const count = 1; // count\r\n// read\r\nfunction read() { return count; }\r\n",
    output: "const count = 1; // count\r\n\r\n// read\r\nfunction read() { return count; }\r\n",
    errors: [{ messageId: "expectedBlankLine" }],
  },
]
