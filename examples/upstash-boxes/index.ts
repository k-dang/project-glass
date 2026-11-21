import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseEnv, promisify } from "node:util"
import { gzip } from "node:zlib"
import { Box, BoxError } from "@upstash/box"
import type { AgentModel, Plugin, SandboxState } from "@glass/plugin"

const run = promisify(execFile)

const gzipped = promisify(gzip)

const KEYS = join(import.meta.dirname, ".env")

const WORK = "/workspace/home/glass"

const HOST = "/workspace/home/.glass"

const BUNDLE = "/workspace/home/agent-host.mjs.gz"

const PLACEHOLDER = "added-by-the-upstash-proxy"

const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

const DEFAULT_MODEL: AgentModel = { id: "default", name: "Sonnet", efforts: EFFORTS }

const MODELS: ReadonlyArray<AgentModel> = [
  { id: "sonnet", name: "Sonnet", efforts: EFFORTS },
  { id: "fable", name: "Fable", efforts: EFFORTS },
  { id: "opus", name: "Opus", efforts: EFFORTS },
  { id: "haiku", name: "Haiku", efforts: EFFORTS },
]

// WARNING: Also the Box's init command, so the host comes back each time a request resumes a paused Box.
const START_HOST = `cd ${WORK} && setsid nohup flock -n ${HOST}/host.lock node ${HOST}/agent-host.mjs >> ${HOST}/host.log 2>&1 < /dev/null &`

const decode = (state: SandboxState) => {
  if (typeof state === "object" && state !== null && "name" in state && "port" in state) {
    const { name, port } = state

    if (typeof name === "string" && typeof port === "number") return { name, port }
  }

  throw new Error("This isn't an Upstash Box's state")
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const EDIT_KEYS =
  process.platform === "win32"
    ? `notepad '${KEYS.replaceAll("'", "''")}'`
    : `"\${EDITOR:-vi}" ${quote(KEYS)}`

const gitConfig = (key: string) =>
  run("git", ["config", "--get", key], { cwd: homedir(), windowsHide: true }).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  )

const shell = async (box: Box, script: string) => {
  const done = await box.exec.command(script)

  if (done.exitCode !== 0)
    throw new Error(`A command in the Box exited ${done.exitCode}: ${done.stderr.trim()}`)
}

const upstashBoxes: Plugin = (glass) => {
  const key = async (name: string, login: string) => {
    const keys = parseEnv(await readFile(KEYS, "utf8").catch(() => ""))
    // WARNING: `claude setup-token` wraps its token across lines in a narrow terminal, so a pasted one can hold spaces.
    const value = keys[name]?.replaceAll(/\s/g, "")

    if (value) return value

    throw glass.missingLogin(`${login}, as ${name}=<value> on one line of ${KEYS}`, EDIT_KEYS)
  }

  const boxKey = () => key("UPSTASH_BOX_API_KEY", "an Upstash Box API key")

  const githubToken = async (signal: AbortSignal) => {
    try {
      const { stdout } = await run("gh", ["auth", "token"], { windowsHide: true, signal })

      return stdout.trim()
    } catch {
      throw glass.missingLogin("GitHub", "gh auth login")
    }
  }

  const withBox = async <T>(
    state: SandboxState,
    work: (box: Box, port: number) => Promise<T>,
  ): Promise<T> => {
    const { name, port } = decode(state)

    try {
      return await work(await Box.getByName(name, { apiKey: await boxKey() }), port)
    } catch (error) {
      if (error instanceof BoxError && error.statusCode === 404) throw glass.sandboxGone()

      throw error
    }
  }

  glass.registerSandboxProvider("upstash", {
    name: "Upstash Boxes",
    harnesses: ["claude-code"],
    create: async (request, { progress, record, signal }) => {
      progress("Creating the Box")

      const [apiKey, claude, github, gitName, gitEmail, bundle] = await Promise.all([
        boxKey(),
        key("CLAUDE_CODE_OAUTH_TOKEN", "a Claude token from `claude setup-token`"),
        githubToken(signal),
        gitConfig("user.name"),
        gitConfig("user.email"),
        readFile(request.host.bundle).then((file) => gzipped(file)),
      ])

      const name = `glass-${randomUUID()}`
      const basic = Buffer.from(`x-access-token:${github}`).toString("base64")

      record({ name, port: request.host.port })
      signal.throwIfAborted()

      const box = await Box.create({
        apiKey,
        name,
        runtime: "node",
        initCommand: START_HOST,
        env: {
          ...request.host.environment,
          CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER,
          GH_TOKEN: PLACEHOLDER,
        },
        git: { userName: gitName, userEmail: gitEmail },
        // WARNING: Upstash's proxy adds these headers on the way out, so the tokens never enter the Box. It takes them only at creation.
        attachHeaders: {
          "api.anthropic.com": { authorization: `Bearer ${claude}` },
          "github.com": { authorization: `Basic ${basic}` },
          "api.github.com": { authorization: `Bearer ${github}` },
        },
      }).catch((error) => {
        if (error instanceof BoxError && error.statusCode === 429)
          throw glass.noCapacity("Upstash has no room for another Box right now")

        throw error
      })

      // WARNING: Glass may have run `remove` before the Box existed, so a Box that finishes after a cancel deletes itself.
      if (signal.aborted) {
        await box.delete().catch((error) => {
          if (!(error instanceof BoxError && error.statusCode === 404)) throw error
        })
        signal.throwIfAborted()
      }

      // WARNING: Writing files through Upstash's API rewrites any git index in the Box as root, which locks git out, so the bundle goes in before the clone.
      // WARNING: Upstash refuses files somewhere under the bundle's 14 MB, so it travels gzipped.
      await box.files.write({
        path: BUNDLE,
        content: bundle.toString("base64"),
        encoding: "base64",
      })

      signal.throwIfAborted()
      progress("Cloning the repository")
      const { owner, repo } = request.repository
      const clone = `${WORK}/${request.folder}`

      await shell(
        box,
        [
          `mkdir -p ${HOST}`,
          `gunzip -c ${BUNDLE} > ${HOST}/agent-host.mjs`,
          `rm ${BUNDLE}`,
          `git clone --quiet --single-branch --branch ${quote(request.baseBranch)} ${quote(`https://github.com/${owner}/${repo}.git`)} ${quote(clone)}`,
          `git -C ${quote(clone)} checkout --quiet -b ${quote(request.branch)} ${quote(`origin/${request.baseBranch}`)}`,
        ].join(" && "),
      )

      signal.throwIfAborted()
      progress("Starting the agent")
      await shell(box, START_HOST)
    },
    target: (state) =>
      withBox(state, async (box, port) => {
        const [{ url }] = await Promise.all([box.getPublicURL(port), shell(box, START_HOST)])

        return { url, headers: {} }
      }),
    remove: (state) => withBox(state, (box) => box.delete()),
    models: async () => ({ defaultModel: DEFAULT_MODEL, models: MODELS }),
  })
}

export default upstashBoxes
