import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { promisify } from "node:util"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models"
import { VERCEL_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/vercel-ai-gateway.models"
import { getVercelToken } from "@vercel/oidc"
import { APIError, type NetworkPolicy, Sandbox } from "@vercel/sandbox"
import type { AgentModel, Json, Plugin, SandboxState } from "@glass/plugin"

const run = promisify(execFile)

const PROJECT = "glass-sandboxes"

const SESSION = 45 * 60_000

const WORK = "/vercel/glass"

const HOST = "/vercel/.glass"

const PLACEHOLDER = "added-by-the-vercel-firewall"

const MODELS: ReadonlyArray<AgentModel> = Object.values(VERCEL_AI_GATEWAY_MODELS).map((model) => ({
  id: `vercel-ai-gateway/${model.id}`,
  name: model.name,
  efforts: model.reasoning ? getSupportedThinkingLevels(model) : [],
}))

const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5"

const DEFAULT_AGENT_MODEL = MODELS.find(({ id }) => id === `vercel-ai-gateway/${DEFAULT_MODEL}`)

if (DEFAULT_AGENT_MODEL === undefined)
  throw new Error(`pi-ai doesn't list ${DEFAULT_MODEL}; pick a default model it has`)

// flock keeps a second start from racing the running host for its port.
const START_HOST = `cd ${WORK} && set -a && . ${HOST}/host.env && set +a && exec flock -n ${HOST}/host.lock node ${HOST}/agent-host.mjs >> ${HOST}/host.log 2>&1`

interface SandboxAddress {
  readonly name: string
  readonly teamId: string
  readonly projectId: string
}

const at = (value: Json | undefined, key: string): Json | undefined =>
  typeof value === "object" && value !== null
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined

const textAt = (value: Json | undefined, key: string) => {
  const found = at(value, key)

  return typeof found === "string" ? found : undefined
}

const decode = (state: SandboxState) => {
  const name = textAt(state, "name")
  const teamId = textAt(state, "teamId")
  const projectId = textAt(state, "projectId")
  const port = at(state, "port")

  if (
    name === undefined ||
    teamId === undefined ||
    projectId === undefined ||
    typeof port !== "number"
  )
    throw new Error("This isn't a Vercel Sandbox's state")

  return { port, sandbox: { name, teamId, projectId } satisfies SandboxAddress }
}

const vercelApi = (
  token: string,
  teamId: string | undefined,
  path: string,
  signal: AbortSignal,
  init: { method?: string; body?: Json } = {},
) => {
  const url = new URL(path, "https://api.vercel.com")

  if (teamId !== undefined) url.searchParams.set("teamId", teamId)

  return fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal,
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
}

const expectJson = async (response: Response, what: string): Promise<Json> => {
  if (!response.ok)
    throw new Error(`Vercel refused to ${what}: ${response.status} ${await response.text()}`)

  return JSON.parse(await response.text())
}

const defaultTeam = async (token: string, signal: AbortSignal) => {
  const user = await expectJson(
    await vercelApi(token, undefined, "/v2/user", signal),
    "name your account",
  )

  const team = textAt(at(user, "user"), "defaultTeamId")

  if (team === undefined) throw new Error("Vercel named no team for your account")

  return team
}

const projectOf = async (token: string, teamId: string, signal: AbortSignal) => {
  const lookUp = () => vercelApi(token, teamId, `/v9/projects/${PROJECT}`, signal)

  let response = await lookUp()

  if (response.status === 404) {
    response = await vercelApi(token, teamId, "/v11/projects", signal, {
      method: "POST",
      body: { name: PROJECT },
    })

    if (response.status === 409) response = await lookUp()
  }

  const id = textAt(await expectJson(response, `find or create ${PROJECT}`), "id")

  if (id === undefined) throw new Error(`Vercel gave ${PROJECT} no id`)

  return id
}

const oidcToken = async (
  token: string,
  { teamId, projectId }: Pick<SandboxAddress, "teamId" | "projectId">,
  signal: AbortSignal,
) => {
  const minted = await expectJson(
    await vercelApi(
      token,
      teamId,
      `/v1/projects/${projectId}/token?source=vercel-oidc-refresh`,
      signal,
      { method: "POST" },
    ),
    `give ${PROJECT} an OIDC token`,
  )

  const oidc = textAt(minted, "token")

  if (oidc === undefined) throw new Error(`Vercel gave ${PROJECT} no OIDC token`)

  return oidc
}

const gitConfig = (key: string) =>
  run("git", ["config", "--get", key], { cwd: homedir(), windowsHide: true }).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  )

const gitIdentity = async () => {
  const [name, email] = await Promise.all([gitConfig("user.name"), gitConfig("user.email")])

  return { GIT_NAME: name, GIT_EMAIL: email }
}

const shellEnvironment = (environment: Readonly<Record<string, string>>) =>
  Object.entries(environment)
    .map(([key, value]) => `${key}='${value.replaceAll("'", `'\\''`)}'`)
    .join("\n")

const shell = async (
  sandbox: Sandbox,
  script: string,
  signal: AbortSignal,
  env: Readonly<Record<string, string>>,
) => {
  const done = await sandbox.runCommand({ cmd: "bash", args: ["-lc", script], env, signal })

  if (done.exitCode !== 0)
    throw new Error(
      `A command in the Sandbox exited ${done.exitCode}: ${(await done.stderr()).trim()}`,
    )
}

// Not given a signal: aborting a detached command's request would kill the host it started.
const startHost = (sandbox: Sandbox) =>
  sandbox.runCommand({ cmd: "bash", args: ["-lc", START_HOST], detached: true })

const vercelSandboxes: Plugin = (glass) => {
  const missing = <T>(call: () => Promise<T>) =>
    call().catch((error: Error) => {
      if (
        error instanceof APIError &&
        (error.response.status === 404 ||
          textAt(at(error.json ?? null, "error"), "code") === "snapshot_not_found")
      )
        throw glass.sandboxGone()

      throw error
    })

  const vercelToken = () =>
    getVercelToken({ expirationBufferMs: 5 * 60_000 }).catch(() => {
      throw glass.missingLogin("Vercel", "vercel login")
    })

  const githubToken = async (signal: AbortSignal) => {
    try {
      const { stdout } = await run("gh", ["auth", "token"], { windowsHide: true, signal })

      return stdout.trim()
    } catch {
      throw glass.missingLogin("GitHub", "gh auth login")
    }
  }

  // The firewall adds these headers on the way out, so no secret is ever inside the Sandbox.
  const networkPolicy = async (
    token: string,
    where: Pick<SandboxAddress, "teamId" | "projectId">,
    signal: AbortSignal,
  ): Promise<NetworkPolicy> => {
    const [oidc, github] = await Promise.all([oidcToken(token, where, signal), githubToken(signal)])
    const basic = Buffer.from(`x-access-token:${github}`).toString("base64")

    return {
      allow: {
        "ai-gateway.vercel.sh": [
          { transform: [{ headers: { authorization: `Bearer ${oidc}`, "x-api-key": oidc } }] },
        ],
        "github.com": [{ transform: [{ headers: { authorization: `Basic ${basic}` } }] }],
        "api.github.com": [{ transform: [{ headers: { authorization: `Bearer ${github}` } }] }],
        "*": [],
      },
    }
  }

  glass.registerSandboxProvider("vercel", {
    name: "Vercel Sandboxes",
    harnesses: ["pi"],
    create: async (request, { progress, record, signal }) => {
      progress("Creating the Sandbox")

      const [token, bundle, identity] = await Promise.all([
        vercelToken(),
        readFile(request.host.bundle),
        gitIdentity(),
      ])

      const teamId = await defaultTeam(token, signal)
      const projectId = await projectOf(token, teamId, signal)
      const address = { name: `glass-${randomUUID()}`, teamId, projectId }
      const policy = await networkPolicy(token, address, signal)

      record({ ...address, port: request.host.port })

      const sandbox = await Sandbox.create({
        token,
        teamId,
        projectId,
        name: address.name,
        ports: [request.host.port],
        timeout: SESSION,
        networkPolicy: policy,
        signal,
      }).catch((error: Error) => {
        if (error instanceof APIError && error.response.status === 429)
          throw glass.noCapacity("Vercel has no room for another Sandbox right now")

        throw error
      })

      progress("Cloning the repository")
      const { owner, repo } = request.repository

      await shell(
        sandbox,
        [
          `mkdir -p ${WORK} ${HOST} /vercel/.pi/agent`,
          `git clone --quiet --single-branch --branch "$BASE" "$URL" "$CLONE"`,
          `git -C "$CLONE" checkout --quiet -b "$BRANCH" "origin/$BASE"`,
          `if [ -n "$GIT_NAME" ]; then git config --global user.name "$GIT_NAME"; fi`,
          `if [ -n "$GIT_EMAIL" ]; then git config --global user.email "$GIT_EMAIL"; fi`,
        ].join(" && "),
        signal,
        {
          BASE: request.baseBranch,
          BRANCH: request.branch,
          URL: `https://github.com/${owner}/${repo}.git`,
          CLONE: `${WORK}/${request.folder}`,
          ...identity,
        },
      )

      progress("Starting the agent")

      await sandbox.writeFiles(
        [
          { path: `${HOST}/agent-host.mjs`, content: bundle },
          {
            path: `${HOST}/host.env`,
            content: shellEnvironment({
              ...request.host.environment,
              AI_GATEWAY_API_KEY: PLACEHOLDER,
              GH_TOKEN: PLACEHOLDER,
            }),
            mode: 0o600,
          },
          {
            path: "/vercel/.pi/agent/settings.json",
            content: JSON.stringify({
              defaultProvider: "vercel-ai-gateway",
              defaultModel: DEFAULT_MODEL,
            }),
          },
        ],
        { signal },
      )
      await startHost(sandbox)
    },
    target: async (state, signal) => {
      const { port, sandbox: address } = decode(state)
      const token = await vercelToken()

      const [sandbox, policy] = await Promise.all([
        missing(() => Sandbox.get({ token, ...address, signal })),
        networkPolicy(token, address, signal),
      ])

      await missing(() => sandbox.update({ networkPolicy: policy }, { signal }))
      await missing(() => startHost(sandbox))

      return { url: sandbox.domain(port), headers: {} }
    },
    remove: async (state, signal) => {
      const { sandbox: address } = decode(state)
      const token = await vercelToken()
      const sandbox = await missing(() => Sandbox.get({ token, ...address, signal }))

      await missing(() => sandbox.delete({ deleteOrphanSnapshots: true, signal }))
    },
    models: async () => ({ defaultModel: DEFAULT_AGENT_MODEL, models: MODELS }),
  })
}

export default vercelSandboxes
