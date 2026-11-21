import { bash, edit, lines, read, scriptedThread, write } from "./demoScript"

const packageJson = lines(
  "{",
  '  "name": "hello-world",',
  '  "version": "0.1.0",',
  '  "type": "module",',
  '  "bin": { "hello": "bin/hello.js" },',
  '  "scripts": { "test": "node --test" }',
  "}",
  "",
)

const firstGreet = "export const greet = (name) => `Hello, ${name}!`\n"

const firstCli = lines(
  "#!/usr/bin/env node",
  'import { greet } from "../src/greet.js"',
  "",
  'console.log(greet(process.argv[2] ?? "world"))',
  "",
)

const blankSafeGreet = lines(
  "export const greet = (name) => {",
  "  const trimmed = name.trim()",
  "",
  '  return `Hello, ${trimmed === "" ? "world" : trimmed}!`',
  "}",
)

const blankNameTest = lines(
  'test("falls back to world for a blank name", () => {',
  '  assert.equal(greet("   "), "Hello, world!")',
  "})",
)

const firstTests = lines(
  'import assert from "node:assert/strict"',
  'import { test } from "node:test"',
  'import { greet } from "../src/greet.js"',
  "",
  'test("greets someone by name", () => {',
  '  assert.equal(greet("Ada"), "Hello, Ada!")',
  "})",
  "",
  blankNameTest,
  "",
)

const parseArgsCli = lines(
  "#!/usr/bin/env node",
  'import { parseArgs } from "node:util"',
  'import { greetAll } from "../src/greet.js"',
  "",
  "const { values, positionals } = parseArgs({",
  "  allowPositionals: true,",
  "  options: {",
  '    shout: { type: "boolean", short: "s", default: false },',
  "  },",
  "})",
  "",
  "console.log(greetAll(positionals, { shout: values.shout }))",
  "",
)

export const longThread = scriptedThread({
  name: "demo/greeting-cli",
  turns: [
    [
      "Let's turn hello-world into a small greeting CLI. Start by looking around.",
      [
        {
          thinking:
            "Before proposing anything I should see what is already here: the files, the history, and the README.",
          tools: [bash("ls -la && git log --oneline --all && cat README.md")],
        },
        {
          text: lines(
            "There isn't much here yet, which makes this easy to shape.",
            "",
            "- **One file:** `README.md`, containing only the `# hello-world` heading.",
            "- **One commit:** `Start`, shared by `main` and `develop`.",
            "- **No tooling:** no `package.json`, no tests, no CI.",
            "",
            "Since nothing exists to stay compatible with, we can pick the layout freely. I'd keep it to plain Node with ES modules and the built-in test runner, so the project has no dependencies at all.",
          ),
        },
      ],
    ],
    [
      "What layout would you suggest?",
      [
        {
          text: lines(
            "I'd split the code that builds a greeting from the code that reads the command line:",
            "",
            "```text",
            "hello-world/",
            "├── bin/",
            "│   └── hello.js      # reads argv, prints",
            "├── src/",
            "│   └── greet.js      # pure functions, no I/O",
            "├── test/",
            "│   └── greet.test.js",
            "├── package.json",
            "└── README.md",
            "```",
            "",
            "Keeping `src/greet.js` free of `process` and `console` means every behavior we care about can be tested by calling a function and comparing a string. The `bin/` script stays a thin shell around it.",
            "",
            'The `bin` field in `package.json` lets `npm link` install it as a `hello` command later, and `"type": "module"` lets us use `import` without `.mjs` extensions.',
          ),
        },
      ],
    ],
    [
      "Sounds good. Create the package.json.",
      [
        { tools: [write("package.json", packageJson)] },
        {
          text: "Created `package.json`. `npm test` runs `node --test`, which finds every `*.test.js` file on its own, so there is nothing else to configure.",
        },
      ],
    ],
    [
      "Now write the greet function.",
      [
        { tools: [write("src/greet.js", firstGreet)] },
        {
          text: lines(
            "Added `src/greet.js`:",
            "",
            "```js",
            firstGreet.trimEnd(),
            "```",
            "",
            "It's deliberately tiny for now. We'll grow it as the CLI needs more.",
          ),
        },
      ],
    ],
    [
      "Add the CLI entry point and try it.",
      [
        {
          tools: [
            write("bin/hello.js", firstCli),
            bash("node bin/hello.js && node bin/hello.js Ada"),
          ],
        },
        {
          text: "Both runs work: no argument prints `Hello, world!`, and `Ada` prints `Hello, Ada!`.",
        },
      ],
    ],
    [
      "What happens with an empty name?",
      [
        {
          thinking:
            'An empty string is not undefined, so the `?? "world"` fallback will not kick in. Let me confirm rather than guess.',
          tools: [bash('node bin/hello.js "" && node bin/hello.js "   "')],
        },
        {
          text: lines(
            "It prints `Hello, !` and `Hello,    !`, which is a bug.",
            "",
            '`??` only replaces `null` and `undefined`, and `""` is neither. Whitespace-only names slip through for the same reason.',
            "",
            "The fix belongs in `greet` rather than the CLI, so any future caller gets the same behavior: trim the name, and fall back to `world` when nothing is left.",
          ),
        },
      ],
    ],
    [
      "Fix it.",
      [
        {
          tools: [
            edit("src/greet.js", [{ oldText: firstGreet.trimEnd(), newText: blankSafeGreet }]),
            bash('node bin/hello.js "" && node bin/hello.js "  Grace  "'),
          ],
        },
        {
          text: 'Fixed. Blank names fall back to `world`, and surrounding spaces are trimmed, so `"  Grace  "` prints `Hello, Grace!`.',
        },
      ],
    ],
    [
      "Add tests for what we have so far.",
      [
        {
          tools: [write("test/greet.test.js", firstTests), bash("node --test")],
        },
        {
          text: "Two tests, both passing: one for the normal case and one pinning down the blank-name fix so it can't regress quietly.",
        },
      ],
    ],
    [
      "Add a --shout flag that uppercases the greeting.",
      [
        {
          thinking:
            "Shouting is formatting, so it belongs in greet as an option. The CLI only needs to notice the flag and keep it out of the name.",
          tools: [
            edit("src/greet.js", [
              {
                oldText: "export const greet = (name) => {",
                newText: "export const greet = (name, { shout = false } = {}) => {",
              },
              {
                oldText: '  return `Hello, ${trimmed === "" ? "world" : trimmed}!`',
                newText: lines(
                  '  const greeting = `Hello, ${trimmed === "" ? "world" : trimmed}!`',
                  "",
                  "  return shout ? greeting.toUpperCase() : greeting",
                ),
              },
            ]),
            edit("bin/hello.js", [
              {
                oldText: 'console.log(greet(process.argv[2] ?? "world"))',
                newText: lines(
                  "const args = process.argv.slice(2)",
                  'const shout = args.includes("--shout")',
                  'const name = args.find((arg) => !arg.startsWith("--")) ?? "world"',
                  "",
                  "console.log(greet(name, { shout }))",
                ),
              },
            ]),
          ],
        },
        { tools: [bash("node bin/hello.js --shout Ada && node bin/hello.js Ada --shout")] },
        {
          text: lines(
            "`--shout` works in either position:",
            "",
            "```text",
            "$ node bin/hello.js --shout Ada",
            "HELLO, ADA!",
            "```",
            "",
            "`greet` takes an options object, so adding more formatting later won't change its signature again.",
          ),
        },
      ],
    ],
    [
      "Add a test for shouting.",
      [
        {
          tools: [
            edit("test/greet.test.js", [
              {
                oldText: blankNameTest,
                newText: lines(
                  blankNameTest,
                  "",
                  'test("shouts when asked", () => {',
                  '  assert.equal(greet("Ada", { shout: true }), "HELLO, ADA!")',
                  "})",
                ),
              },
            ]),
            bash("node --test"),
          ],
        },
        { text: "Three tests now, all green." },
      ],
    ],
    [
      "Could it greet several people at once?",
      [
        {
          text: lines(
            "Yes, and it fits the current shape well. I'd add one function next to `greet` and keep `greet` itself unchanged:",
            "",
            "```js",
            "export const greetAll = (names, options) =>",
            '  (names.length === 0 ? ["world"] : names).map((name) => greet(name, options)).join("\\n")',
            "```",
            "",
            "Each name gets its own line, which keeps the output easy to pipe into other tools:",
            "",
            "```text",
            "$ hello Ada Grace Linus",
            "Hello, Ada!",
            "Hello, Grace!",
            "Hello, Linus!",
            "```",
            "",
            "The alternative is a single sentence (`Hello, Ada, Grace and Linus!`). It reads nicer for two or three names but needs list-joining rules, and it gets awkward fast. I'd start with one line per name.",
          ),
        },
      ],
    ],
    [
      "Go with one line per name.",
      [
        {
          tools: [
            edit("src/greet.js", [
              {
                oldText: "  return shout ? greeting.toUpperCase() : greeting\n}",
                newText: lines(
                  "  return shout ? greeting.toUpperCase() : greeting",
                  "}",
                  "",
                  "export const greetAll = (names, options) =>",
                  '  (names.length === 0 ? ["world"] : names).map((name) => greet(name, options)).join("\\n")',
                ),
              },
            ]),
            edit("bin/hello.js", [
              {
                oldText: 'import { greet } from "../src/greet.js"',
                newText: 'import { greetAll } from "../src/greet.js"',
              },
              {
                oldText: lines(
                  'const name = args.find((arg) => !arg.startsWith("--")) ?? "world"',
                  "",
                  "console.log(greet(name, { shout }))",
                ),
                newText: lines(
                  'const names = args.filter((arg) => !arg.startsWith("--"))',
                  "",
                  "console.log(greetAll(names, { shout }))",
                ),
              },
            ]),
          ],
        },
        {
          tools: [bash("node bin/hello.js Ada Grace Linus && node bin/hello.js --shout Ada Grace")],
        },
        {
          text: "Done. Several names print one greeting each, and `--shout` applies to all of them.",
        },
      ],
    ],
    [
      "Run the whole test suite with the spec reporter.",
      [
        { tools: [bash("node --test --test-reporter=spec")] },
        {
          text: lines(
            "All three tests pass, but none of them covers `greetAll` yet. Worth adding two:",
            "",
            "1. several names produce one line each, in order;",
            "2. no names at all falls back to `Hello, world!`.",
            "",
            "I'll add those when we next touch the tests.",
          ),
        },
      ],
    ],
    [
      "Show me everything that changed so far.",
      [
        { tools: [bash("git status --short && git add -A && git diff --cached --stat")] },
        {
          text: "Four new files and nothing modified yet. I staged them so the stat above is complete; nothing is committed.",
        },
      ],
    ],
    [
      "Update the README with usage instructions.",
      [
        {
          tools: [
            edit("README.md", [
              {
                oldText: "# hello-world",
                newText: lines(
                  "# hello-world",
                  "",
                  "A tiny greeting CLI.",
                  "",
                  "## Usage",
                  "",
                  "```sh",
                  "node bin/hello.js              # Hello, world!",
                  "node bin/hello.js Ada Grace    # one line per name",
                  "node bin/hello.js --shout Ada  # HELLO, ADA!",
                  "```",
                  "",
                  "## Tests",
                  "",
                  "```sh",
                  "npm test",
                  "```",
                ),
              },
            ]),
          ],
        },
        { text: "The README now covers running the CLI and the tests." },
      ],
    ],
    [
      "Explain how the argument parsing works right now.",
      [
        { tools: [read("bin/hello.js")] },
        {
          text: lines(
            "It's hand-rolled, in three lines:",
            "",
            "```js",
            "const args = process.argv.slice(2)",
            'const shout = args.includes("--shout")',
            'const names = args.filter((arg) => !arg.startsWith("--"))',
            "```",
            "",
            "`process.argv` starts with the path to `node` and the path to the script, so `slice(2)` keeps only what the user typed. Anything starting with `--` is treated as a flag and everything else as a name.",
            "",
            "That's fine for one flag, but it has sharp edges:",
            "",
            "- **Typos pass silently.** `--shuot` is ignored instead of reported.",
            "- **No short flags.** `-s` would be taken as a name and greeted.",
            "- **No way to greet `--shout` literally.** There's no `--` separator.",
            "",
            "None of these matter much today, but each new flag makes them worse.",
          ),
        },
      ],
    ],
    [
      "Would you switch to util.parseArgs?",
      [
        {
          thinking:
            "parseArgs is built into Node 18.3+, so it keeps the zero-dependency goal. It rejects unknown options by default, which fixes the typo problem.",
          text: lines(
            "Yes. `util.parseArgs` ships with Node, so we stay dependency-free, and it fixes all three problems:",
            "",
            "| Problem | `parseArgs` |",
            "| --- | --- |",
            "| Typos pass silently | Unknown options throw by default |",
            '| No short flags | `short: "s"` maps `-s` to `--shout` |',
            "| Can't greet `--shout` | `--` ends option parsing |",
            "",
            "The cost is a few more lines of setup, and errors surface as a thrown `TypeError` with a stack trace unless we catch it. I think that's an acceptable trade for a CLI this size.",
          ),
        },
      ],
    ],
    [
      "Do it.",
      [
        {
          tools: [
            write("bin/hello.js", parseArgsCli),
            bash("node bin/hello.js -s Ada Grace && node bin/hello.js -- --shout && node --test"),
          ],
        },
        {
          text: "Rewritten with `parseArgs`. `-s` works as a short flag, `--` lets `--shout` be a name, and the tests still pass.",
        },
      ],
    ],
    [
      "What happens with an unknown flag now?",
      [
        { tools: [bash("node bin/hello.js --shuot Ada 2>&1 | head -n 12; true")] },
        {
          text: lines(
            "It's rejected, which is what we wanted, but the stack trace is noisy for a CLI. A friendlier version would catch the error and print just the message:",
            "",
            "```js",
            "try {",
            "  // parseArgs(...)",
            "} catch (error) {",
            "  console.error(`hello: ${error.message}`)",
            "  process.exit(2)",
            "}",
            "```",
            "",
            "Exit code `2` is the usual convention for usage errors. Want me to add that next?",
          ),
        },
      ],
    ],
    [
      "Not yet. Summarize what we built.",
      [
        {
          text: lines(
            "Here's where `hello-world` stands:",
            "",
            "- **`src/greet.js`** builds greetings: `greet(name, { shout })` for one name, `greetAll(names, options)` for several, with blank names falling back to `world`.",
            "- **`bin/hello.js`** parses arguments with `util.parseArgs` (`--shout`/`-s`, positional names, `--` separator) and prints one line per name.",
            "- **`test/greet.test.js`** covers naming, the blank-name fallback, and shouting.",
            "- **`README.md`** documents usage and how to run the tests.",
            "- **`package.json`** wires up `npm test` and the `hello` binary.",
            "",
            "Open follow-ups:",
            "",
            "1. tests for `greetAll`;",
            "2. friendly errors for unknown flags;",
            "3. a `--help` flag.",
          ),
        },
      ],
    ],
    [
      "Commit it.",
      [
        {
          tools: [
            bash(
              'git add -A && git -c user.name="Demo Agent" -c user.email=agent@example.invalid commit --quiet -m "Add a greeting CLI" && git log --stat -1',
            ),
          ],
        },
        {
          text: "Committed as **Add a greeting CLI** on this Thread's branch. Nothing is pushed.",
        },
      ],
    ],
  ],
})
