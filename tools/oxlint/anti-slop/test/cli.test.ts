import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vite-plus/test"
import { spacingFixes } from "./spacing-fixtures.ts"

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve("oxlint/package.json")), "bin/oxlint")
const pluginRoot = fileURLToPath(new URL("../", import.meta.url))

type CliDiagnostic = { code: string; message: string; severity: string }

function withCliFixture(
  run: (
    directory: string,
    lint: (...args: string[]) => SpawnSyncReturns<string>,
  ) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "glass-anti-slop-"))
  try {
    const config = join(directory, ".oxlintrc.json")
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        plugins: [],
        jsPlugins: [
          { name: "anti-slop", specifier: resolve(pluginRoot, "index.ts") },
          { name: "anti-slop-effect", specifier: resolve(pluginRoot, "effect/index.ts") },
        ],
        rules: {
          "anti-slop/require-safety-comment-for-type-assertion": "error",
          "anti-slop/no-chained-type-assertions": "error",
          "anti-slop/require-readable-spacing": "error",
          "anti-slop-effect/no-manual-effect-error-tag": "error",
          "anti-slop-effect/no-manual-tag-comparison": "error",
          "anti-slop-effect/no-manual-tagged-construction": "error",
        },
      }),
    )
    run(directory, (...args) => {
      const result = spawnSync(
        process.execPath,
        [cli, "--config", config, "--format", "json", ...args],
        {
          cwd: directory,
          encoding: "utf8",
        },
      )
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.stderr).toBe("")
      return result
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

it("loads both registered plugins, reports actionable diagnostics, and keeps non-fixable assertions intact", () => {
  withCliFixture((directory, lint) => {
    const source = "export const value = input as unknown as Payload;\n"
    const tagged =
      "import { Effect } from 'effect';\n\nEffect.catch(error => error.reason['_tag'] === 'Missing' ? recover : fail);\n\nexport const value = { _tag: 'Missing' };\n"
    writeFileSync(join(directory, "assertion.ts"), source)
    writeFileSync(join(directory, "tagged.ts"), tagged)

    const rejected = lint("assertion.ts", "tagged.ts")
    expect(rejected.status, rejected.stdout).toBe(1)
    const diagnostics: CliDiagnostic[] = JSON.parse(rejected.stdout).diagnostics
    expect(diagnostics).toHaveLength(5)
    expect(diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual(
      [
        "anti-slop-effect(no-manual-effect-error-tag)",
        "anti-slop-effect(no-manual-tagged-construction)",
        "anti-slop(no-chained-type-assertions)",
        "anti-slop(require-safety-comment-for-type-assertion)",
        "anti-slop(require-safety-comment-for-type-assertion)",
      ].sort(),
    )
    expect(
      diagnostics.find((diagnostic) => diagnostic.code.includes("no-manual-effect-error-tag"))?.message,
    ).toContain("Effect.catchReason or Effect.catchReasons")
    expect(diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true)

    const fixed = lint("--fix", "assertion.ts", "tagged.ts")
    expect(fixed.status, fixed.stdout).toBe(1)
    expect(readFileSync(join(directory, "assertion.ts"), "utf8")).toBe(source)
    expect(readFileSync(join(directory, "tagged.ts"), "utf8")).toBe(tagged)
  })
})

it("fixes real TS files exactly and a repeated CLI fix leaves every byte unchanged", () => {
  withCliFixture((directory, lint) => {
    const filenames = spacingFixes.map((fixture, index) => {
      const filename = `spacing-${index}.ts`
      writeFileSync(join(directory, filename), fixture.code)
      return filename
    })
    const rejected = lint(...filenames)
    expect(rejected.status, rejected.stdout).toBe(1)
    const diagnostics: CliDiagnostic[] = JSON.parse(rejected.stdout).diagnostics
    expect(diagnostics).toHaveLength(
      spacingFixes.reduce((count, fixture) => count + fixture.errors.length, 0),
    )
    expect(
      diagnostics.every((diagnostic) => diagnostic.code === "anti-slop(require-readable-spacing)"),
    ).toBe(true)

    for (const args of [["--fix", ...filenames], ["--fix", ...filenames], filenames]) {
      const result = lint(...args)
      expect(result.status, result.stdout).toBe(0)
      expect(JSON.parse(result.stdout).diagnostics).toEqual([])
      spacingFixes.forEach((fixture, index) => {
        expect(readFileSync(join(directory, `spacing-${index}.ts`), "utf8"), fixture.name).toBe(
          fixture.output,
        )
      })
    }
  })
})
