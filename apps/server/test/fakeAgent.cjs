const { readFileSync, readdirSync, appendFileSync, existsSync } = require("node:fs")

const path = require("node:path")

const settings = JSON.parse(readFileSync(`${__filename}.json`, "utf8"))

const args = process.argv.slice(2)

const stage = args.includes("--help")
  ? "help"
  : args.includes("auth")
    ? "auth"
    : args.includes("--list-models")
      ? "models"
      : "generate"

const record = { stage, pid: process.pid, cwd: process.cwd(), args }

appendFileSync(`${__filename}.log`, `${JSON.stringify(record)}\n`)

// pi reads `--system-prompt` as a file path; record what the runner wrote there.
const systemPromptFile = () => {
  const index = args.indexOf("--system-prompt")

  return index === -1 ? undefined : readFileSync(args[index + 1], "utf8")
}

const filesInDirectory = () =>
  readdirSync(process.cwd(), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(process.cwd(), path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    )
    .toSorted()

const finish = () => {
  if (stage === "help") {
    console.log(
      settings.helpOutput ??
        "--tools --strict-mcp-config --no-session-persistence --disable-slash-commands --restricted",
    )

    return
  }

  if (stage === "models") {
    console.log(settings.modelsOutput ?? "")

    return
  }

  if (stage === "auth") {
    console.log(JSON.stringify({ loggedIn: settings.ready }))
    process.exitCode = settings.ready ? 0 : 1

    return
  }

  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    input += chunk
  })
  process.stdin.on("end", () => {
    appendFileSync(
      `${__filename}.log`,
      `${JSON.stringify({ ...record, stage: "prompted", input, systemPrompt: systemPromptFile(), files: filesInDirectory() })}\n`,
    )

    const answer = () => {
      if (settings.stderr) console.error(settings.stderr)
      console.log(settings.output)
      process.exitCode = settings.exitCode ?? 0
    }

    if (settings.gate) {
      const timer = setInterval(() => {
        if (existsSync(settings.gate)) {
          clearInterval(timer)
          answer()
        }
      }, 20)
    } else setTimeout(answer, settings.delay ?? 0)
  })
}

if (settings.hangAt === stage) setInterval(() => {}, 1000)
else finish()
