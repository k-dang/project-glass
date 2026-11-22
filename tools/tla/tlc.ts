import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

const toolsDir = import.meta.dirname

const [specArg, ...flags] = process.argv.slice(2)

if (specArg === undefined || flags.some((flag) => flag !== "--mutants")) {
  console.error("Usage: node tools/tla/tlc.ts <Model.tla> [--mutants]")
  process.exit(2)
}

const spec = resolve(specArg)

const config = spec.replace(/\.tla$/, ".cfg")

const modelDir = dirname(spec)

if (!existsSync(spec) || !existsSync(config)) {
  console.error(`Expected ${spec} and ${config}`)
  process.exit(2)
}

const readJson = (file: string): Record<string, string> =>
  existsSync(join(modelDir, file)) ? JSON.parse(readFileSync(join(modelDir, file), "utf8")) : {}

const findings = readJson("findings.json")

const mutants = readJson("mutants.json")

const mise = (...args: Array<string>) => {
  const run = spawnSync("mise", args, { cwd: toolsDir, encoding: "utf8" })

  if (run.status !== 0) {
    console.error(run.stderr || run.stdout)
    process.exit(2)
  }

  return run.stdout.trim()
}

mise("trust", "--quiet", toolsDir)

mise("install", "--quiet")

const jar = join(mise("where", "http:tla2tools"), "tla2tools.jar")

const java = mise("which", "java")

const baseConfig = readFileSync(config, "utf8")

const checkSection = /^(INVARIANTS?|PROPERTY|PROPERTIES)\s*$/

const anySection = /^[A-Z_]+\b/

const checksIn = (text: string) => {
  const names: Array<string> = []
  let inChecks = false

  for (const line of text.split(/\r?\n/)) {
    if (anySection.test(line)) inChecks = checkSection.test(line)
    else if (inChecks && line.trim() !== "") names.push(line.trim())
  }

  return names
}

const allChecks = checksIn(baseConfig)

for (const name of [...Object.keys(findings), ...Object.values(mutants)])
  if (!allChecks.includes(name)) {
    console.error(`${name} is not an INVARIANT or PROPERTY in ${basename(config)}`)
    process.exit(2)
  }

const configWith = (keep: ReadonlyArray<string>, mutant: string | null) => {
  let inChecks = false

  return baseConfig
    .split(/\r?\n/)
    .filter((line) => {
      if (anySection.test(line)) inChecks = checkSection.test(line)
      else if (inChecks && line.trim() !== "") return keep.includes(line.trim())

      return true
    })
    .join("\n")
    .replace(/^(\s*Broken\s*=\s*)\{\s*\}/m, mutant === null ? "$1{}" : `$1{"${mutant}"}`)
}

interface Outcome {
  readonly output: string
  readonly broken: ReadonlyArray<string>
  readonly passed: boolean
}

const check = (keep: ReadonlyArray<string>, mutant: string | null): Outcome => {
  const configText = configWith(keep, mutant)

  const work = mkdtempSync(join(tmpdir(), "glass-tlc-"))

  try {
    const runConfig = join(work, basename(config))
    writeFileSync(runConfig, configText)

    const run = spawnSync(
      java,
      [
        "-XX:+UseParallelGC",
        "-cp",
        jar,
        "tlc2.TLC",
        "-workers",
        "1",
        "-metadir",
        join(work, "states"),
        "-config",
        runConfig,
        basename(spec),
      ],
      { cwd: modelDir, encoding: "utf8", maxBuffer: 1 << 28 },
    )

    const output = `${run.stdout}${run.stderr}`

    const broken = [
      ...[...output.matchAll(/(?:Invariant|Action property) (\w+) is violated/g)].map(
        (match) => match[1] ?? "",
      ),
      ...(output.includes("Temporal properties were violated")
        ? [keep.length === 1 ? (keep[0] ?? "") : "<temporal property>"]
        : []),
      ...(output.includes("Deadlock reached") ? ["<deadlock>"] : []),
    ]

    return {
      output,
      broken,
      passed: run.status === 0 && output.includes("No error has been found"),
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const rules = allChecks.filter((name) => !(name in findings))

console.log(`== Rules that must hold: ${rules.join(", ")}`)

const main = check(rules, null)

process.stdout.write(main.output)

let failed = !main.passed

if (Object.keys(findings).length > 0) console.log("\n== Known findings ==")

for (const [name, finding] of Object.entries(findings)) {
  const outcome = check([name], null)

  if (outcome.broken.includes(name)) {
    console.log(`still breaks  ${name}: ${finding}`)
    process.stdout.write(outcome.output)
  } else {
    failed = true
    console.log(
      `NOW HOLDS     ${name}: ${outcome.passed ? "the finding is gone; move the rule out of findings.json" : "the run errored"}`,
    )

    if (!outcome.passed) process.stdout.write(outcome.output)
  }
}

if (flags.includes("--mutants")) {
  if (!/^\s*Broken\s*=\s*\{\s*\}\s*$/m.test(baseConfig)) {
    console.error(`${basename(config)} must set "Broken = {}" for --mutants`)
    process.exit(2)
  }

  console.log(`\n== Mutants (${Object.keys(mutants).length}) ==`)

  for (const [mutant, expected] of Object.entries(mutants)) {
    if (expected in findings) {
      console.log(`skipped ${mutant} -> ${expected} breaks already (known finding)`)
      continue
    }

    const outcome = check([expected], mutant)
    const caught = outcome.broken.includes(expected)

    if (!caught) failed = true

    console.log(
      `${caught ? "caught " : "MISSED "} ${mutant} -> expected ${expected}, saw ${outcome.broken.join(", ") || (outcome.passed ? "a pass" : "an error")}`,
    )

    if (!caught && !outcome.passed) process.stdout.write(outcome.output)
  }
}

console.log(`\nResult: ${failed ? "FAIL" : "ok"}`)

process.exit(failed ? 1 : 0)
