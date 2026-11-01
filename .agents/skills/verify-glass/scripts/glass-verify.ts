#!/usr/bin/env node
import { Schema } from "effect"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { connect, createServer as createNetServer } from "node:net"
import { basename, delimiter, join } from "node:path"
import { parseArgs } from "node:util"
import { Cdp, cdpJson } from "./cdp.ts"
import { formatAreas, formatSummary, type MemorySample, startSampler } from "./memory.ts"
import { FAKE_MODES, isFakeMode, serveFakeGitHub } from "./fake-github.ts"
import { VIEWER } from "../../../../apps/server/test/fakePullRequest.ts"
import { serveFakeAnthropic } from "./fake-anthropic.ts"
import { fakeAnthropicEnvironment } from "../../../../apps/server/test/pinnedClaude.ts"
import { serveFakePi } from "./fake-pi.ts"

const root = join(import.meta.dirname, "..", "..", "..", "..")
const desktopDir = join(root, "apps", "desktop")
const runsDir = join(root, ".verify")
const isWindows = process.platform === "win32"
const RENDERER_URL = "glass://app/index.html"
const USAGE = `Usage: node .agents/skills/verify-glass/scripts/glass-verify.ts <command> [options]

  launch [--github real|fake] [--fake-mode ok|401|500|down|busy-500] [--no-credentials]
         [--tour-provider fake|real] [--fail-backend-start] [--backend real|fake]
         [--no-build] [--run <id>]
                                         build, start an isolated Glass, wait until ready
                                         Tour provider defaults to fake; real may incur model charges
                                         --backend fake runs pnpm dev:fake's backend and its demo
                                         Agents; it brings its own fake GitHub and providers, and
                                         runs Claude Code Agents on the pinned claude against a
                                         fake Anthropic API
  doctor                                 read-only health check of the run
  text                                   print the window's visible text
  snapshot <name>                        print the accessibility tree; save evidence/<name>.aria.txt
  screenshot <name>                      save evidence/<name>.png
  click --role <role> --name <name>      real mouse click on an accessible element
  type --role <role> --name <name> --text <text>
                                         click the element, then replace its text with <text>
  press --key <key> [--meta]             press a key (e.g. Enter, ArrowUp) in the focused element,
                                         holding ⌘ with --meta
  scroll --by <pixels> [--x <n>] [--y <n>]
                                         turn the wheel over the window, for views that load as you
                                         scroll
  wait --text <text> [--timeout <ms>]    wait until the window shows <text>
  memory [--samples <n>] [--interval <ms>] [--gc] [--out <name>]
                                         sample renderer, worker, and process memory to
                                         evidence/<name>.jsonl, then print what moved
  memory --sweep [--dwell <n>] [--interval <ms>] [--gc] [--out <name>]
                                         visit every rail area in turn, sample it while it
                                         settles, then revisit Dashboard and print one row
                                         per area
                                         --gc collects garbage before each sample, so DOM
                                         counts and commit show what is retained, not what
                                         the collector has not reached yet
  fake-github <ok|401|500|down|busy-500> change what the run's fake GitHub answers
  kill-backend                           kill the backend process, as a crash would
  stop                                   quit Glass, keep logs as evidence, delete run state
  list                                   show runs with live state

Every command except launch/list takes --run <id>; it defaults to the only live run.`

interface RunState {
  readonly id: string
  readonly cdpPort: number
  readonly github: "real" | "fake"
  readonly backend: "real" | "fake"
  readonly fake?: { readonly pid: number; readonly port: number }
  readonly fakePi?: { readonly pid: number; readonly port: number }
  readonly fakeAnthropic?: { readonly pid: number; readonly port: number }
  backendUrl?: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const fail = (message: string): never => {
  console.error(`glass-verify: ${message}`)
  process.exit(1)
}

const runPaths = (id: string) => {
  const dir = join(runsDir, id)
  const state = join(dir, "state")
  return {
    dir,
    state,
    stateFile: join(state, "run.json"),
    fakeModeFile: join(state, "fake-github-mode"),
    userData: join(state, "user-data"),
    home: join(state, "home"),
    electronLog: join(state, "electron.log"),
    backendLog: join(state, "home", ".glass", "logs", "backend.log"),
    evidence: join(dir, "evidence"),
  }
}

const liveRuns = () =>
  existsSync(runsDir) ? readdirSync(runsDir).filter((id) => existsSync(runPaths(id).stateFile)) : []

const loadRun = (id: string | undefined): RunState => {
  if (id === undefined) {
    const live = liveRuns()
    if (live.length > 1) fail(`several live runs (${live.join(", ")}); pass --run <id>`)
    id = live[0] ?? fail("no live run; start one with `launch`")
  }
  const file = runPaths(id).stateFile
  if (!existsSync(file)) fail(`run ${id} has no live state`)
  const run: RunState = JSON.parse(readFileSync(file, "utf8"))
  return run
}

const saveRun = (run: RunState) =>
  writeFileSync(runPaths(run.id).stateFile, JSON.stringify(run, null, 2))

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createNetServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })

const portIsOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1")
    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

const killTree = (pid: number) => {
  if (!isAlive(pid)) return
  if (isWindows) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
  else {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      process.kill(pid, "SIGKILL")
    }
  }
}

const listenerPid = (port: number) => {
  const pid = isWindows
    ? spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" })
        .stdout.split("\n")
        .find((line) => line.includes(`127.0.0.1:${port} `) && line.includes("LISTENING"))
        ?.trim()
        .split(/\s+/)
        .at(-1)
    : spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
        .stdout.trim()
        .split("\n")[0]
  return pid ? Number(pid) : undefined
}

const glassPid = (run: RunState) => listenerPid(run.cdpPort)

const CdpTarget = Schema.Struct({
  type: Schema.String,
  url: Schema.String,
  webSocketDebuggerUrl: Schema.String,
})

const EmptyResponse = Schema.Struct({})

const findWindow = async (run: RunState) => {
  const targets = await cdpJson(
    `http://127.0.0.1:${run.cdpPort}/json/list`,
    Schema.Array(CdpTarget),
  )
  return targets.find(
    (target) => target.type === "page" && target.url.split("#", 1)[0] === RENDERER_URL,
  )
}

const tryOpenWindow = async (run: RunState) => {
  const target = await findWindow(run).catch(() => undefined)
  return target && Cdp.open(target.webSocketDebuggerUrl).catch(() => undefined)
}

const openWindow = async (run: RunState) =>
  (await tryOpenWindow(run)) ?? fail(`no Glass window at ${RENDERER_URL}; run doctor`)

const BackendState = Schema.Struct({
  endpoint: Schema.optional(Schema.Struct({ url: Schema.String, token: Schema.String })),
  failure: Schema.optional(Schema.Struct({ kind: Schema.String, message: Schema.String })),
})

const backendState = (page: Cdp, timeout = 1000) =>
  page
    .evaluate(
      `Promise.race([
        window.glass.backendFailure().then((failure) => ({ failure })),
        window.glass.backendEndpoint().then((endpoint) => ({ endpoint })),
        new Promise((resolve) => setTimeout(() => resolve({}), ${timeout})),
      ])`,
      BackendState,
    )
    .catch((): typeof BackendState.Type => ({}))

const backendHealthy = async (endpoint: { url: string; token: string }) => {
  const http = new URL(endpoint.url.replace(/^ws/, "http"))
  http.pathname = "/health"
  http.searchParams.set("token", endpoint.token)
  const response = await fetch(http).catch(() => undefined)
  return response?.ok === true
}

const AxNode = Schema.Struct({
  nodeId: Schema.String,
  ignored: Schema.Boolean,
  role: Schema.optional(Schema.Struct({ value: Schema.String })),
  name: Schema.optional(Schema.Struct({ value: Schema.String })),
  childIds: Schema.optional(Schema.Array(Schema.String)),
  backendDOMNodeId: Schema.optional(Schema.Int),
})

type AxNode = typeof AxNode.Type

const axTree = async (page: Cdp) =>
  (await page.send("Accessibility.getFullAXTree", Schema.Struct({ nodes: Schema.Array(AxNode) })))
    .nodes

const HIDDEN_ROLES = new Set(["none", "generic", "InlineTextBox"])

const formatAxTree = (nodes: ReadonlyArray<AxNode>) => {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const lines: Array<string> = []
  const visit = (node: AxNode, depth: number) => {
    const shown = !node.ignored && !HIDDEN_ROLES.has(node.role?.value ?? "")
    if (shown) {
      const name = node.name?.value ? ` "${node.name.value}"` : ""
      lines.push(`${"  ".repeat(depth)}${node.role?.value ?? "?"}${name}`)
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child) visit(child, shown ? depth + 1 : depth)
    }
  }
  const first = nodes[0]
  if (first) visit(first, 0)
  return lines.join("\n")
}

const RemoteObject = Schema.Struct({ object: Schema.Struct({ objectId: Schema.String }) })
const Point = Schema.Struct({
  result: Schema.Struct({ value: Schema.Struct({ x: Schema.Number, y: Schema.Number }) }),
})

const clickElement = async (page: Cdp, role: string, name: string) => {
  const node = (await axTree(page)).find(
    (n) => !n.ignored && n.role?.value === role && n.name?.value === name,
  )
  if (node?.backendDOMNodeId === undefined) fail(`no ${role} named "${name}"; run snapshot`)
  const { object } = await page.send("DOM.resolveNode", RemoteObject, {
    backendNodeId: node?.backendDOMNodeId,
  })
  // A control the pointer can't reach, like an `sr-only` radio, takes the click through its label.
  const {
    result: { value: at },
  } = await page.send("Runtime.callFunctionOn", Point, {
    objectId: object.objectId,
    returnByValue: true,
    functionDeclaration: `function () {
      const center = (element) => {
        element.scrollIntoView({ block: "nearest" })
        const box = element.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
      const at = center(this)
      const label = this.labels?.[0]
      return label && !this.contains(document.elementFromPoint(at.x, at.y)) ? center(label) : at
    }`,
  })
  await page.send("Input.dispatchMouseEvent", EmptyResponse, { type: "mouseMoved", ...at })
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", EmptyResponse, {
      type,
      ...at,
      button: "left",
      clickCount: 1,
    })
  }
}

const evidenceDir = (run: RunState) => {
  const dir = runPaths(run.id).evidence
  mkdirSync(dir, { recursive: true })
  return dir
}

const startDetached = (
  command: string,
  args: Array<string>,
  env: NodeJS.ProcessEnv,
  log: string,
) => {
  const out = openSync(log, "a")
  const child: ChildProcess = spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  })
  child.unref()
  if (child.pid === undefined) throw new Error(`could not start ${command}`)
  return child.pid
}

const startFake = async (command: string, args: Array<string>, readyFile: string, log: string) => {
  rmSync(readyFile, { force: true })
  const pid = startDetached(
    process.execPath,
    [import.meta.filename, command, ...args, readyFile],
    process.env,
    log,
  )
  try {
    const deadline = Date.now() + 10_000
    while (!existsSync(readyFile) && isAlive(pid) && Date.now() < deadline) await sleep(100)
    if (!existsSync(readyFile)) {
      throw new Error(`fake did not start; see ${log}`)
    }
    const { port } = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ port: Schema.Int })),
    )(readFileSync(readyFile, "utf8"))
    return { pid, port }
  } catch (error) {
    killTree(pid)
    throw error
  }
}

const withoutGhOnPath = (path: string) =>
  path
    .split(delimiter)
    .filter((dir) => !existsSync(join(dir, isWindows ? "gh.exe" : "gh")))
    .join(delimiter)

const launch = async (options: {
  run?: string
  github: string
  fakeMode: string
  tourProvider: string
  noCredentials: boolean
  failBackendStart: boolean
  backend: string
  noBuild: boolean
}) => {
  const github =
    options.github === "real" || options.github === "fake"
      ? options.github
      : fail("--github is real or fake")
  if (!isFakeMode(options.fakeMode)) fail(`--fake-mode is one of ${FAKE_MODES.join(", ")}`)
  if (options.tourProvider !== "real" && options.tourProvider !== "fake")
    fail("--tour-provider is real or fake")
  if (options.backend !== "real" && options.backend !== "fake") fail("--backend is real or fake")
  const fakeBackend = options.backend === "fake"
  if (fakeBackend && github === "fake") fail("--backend fake brings its own fake GitHub; drop --github fake")
  const id = options.run ?? `run-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`
  const paths = runPaths(id)
  if (existsSync(paths.stateFile)) fail(`run ${id} is already live; stop it or pick another --run`)
  mkdirSync(paths.home, { recursive: true })
  mkdirSync(paths.userData, { recursive: true })
  mkdirSync(paths.evidence, { recursive: true })

  if (!options.noBuild) {
    console.log("Building (pnpm build)...")
    const build = spawnSync("pnpm", ["build"], { cwd: root, stdio: "inherit", shell: isWindows })
    if (build.status !== 0) fail("pnpm build failed")
  }

  const env: NodeJS.ProcessEnv = { ...process.env, GLASS_HOME: paths.home }
  delete env["ELECTRON_RUN_AS_NODE"]
  delete env["VITE_DEV_SERVER_URL"]
  if (fakeBackend) {
    env["GLASS_FAKE_BACKEND"] = "1"
    console.log("Backend: fake, with demo PRs and Agents. Ask a demo pi Agent to work slowly to keep its Turn running.")
  }

  let fakePi: RunState["fakePi"]
  let fakeAnthropic: RunState["fakeAnthropic"]
  let fake: RunState["fake"]
  try {
    if (options.tourProvider === "fake" && !fakeBackend) {
      fakePi = await startFake(
        "__fake-pi",
        [paths.home],
        join(paths.state, "fake-pi-ready.json"),
        join(paths.state, "fake-pi.log"),
      )
      env["PI_CODING_AGENT_DIR"] = join(paths.home, ".pi", "agent")
      env["GLASS_CLAUDE_COMMAND"] = join(paths.state, "claude-disabled-in-fake-provider-mode")
      console.log("Tour provider: fake. Choose pi as the Tour engine in Settings; Claude Code is disabled.")
    }

    if (fakeBackend) {
      // The real pinned `claude`, on a fake Anthropic API with the run's own config and no login.
      fakeAnthropic = await startFake(
        "__fake-anthropic",
        [],
        join(paths.state, "fake-anthropic-ready.json"),
        join(paths.state, "fake-anthropic.log"),
      )
      Object.assign(env, fakeAnthropicEnvironment(paths.home, `http://127.0.0.1:${fakeAnthropic.port}`))
      console.log("Claude Code: the pinned CLI on a fake Anthropic API; no model is called.")
    }

    if (github === "fake") {
      writeFileSync(paths.fakeModeFile, options.fakeMode)
      fake = await startFake(
        "__fake-github",
        [paths.fakeModeFile],
        join(paths.state, "fake-github-ready.json"),
        join(paths.state, "fake-github.log"),
      )
      env["GLASS_GITHUB_API_URL"] = `http://127.0.0.1:${fake.port}`
      env["GH_TOKEN"] = VIEWER.token
      delete env["GITHUB_TOKEN"]
    }
  } catch (error) {
    for (const provider of [fakePi, fakeAnthropic, fake]) {
      if (provider !== undefined) killTree(provider.pid)
    }
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (options.noCredentials) {
    delete env["GH_TOKEN"]
    delete env["GITHUB_TOKEN"]
    env["PATH"] = withoutGhOnPath(env["PATH"] ?? env["Path"] ?? "")
    delete env["Path"]
  }
  if (options.failBackendStart) {
    // NODE_OPTIONS consumes backslash escapes inside quoted paths.
    const preload = join(import.meta.dirname, "fail-backend-start.cjs").replaceAll("\\", "/")
    env["NODE_OPTIONS"] = `${env["NODE_OPTIONS"] ?? ""} --require "${preload}"`.trim()
  }

  const cdpPort = await freePort()
  const electron: string = createRequire(join(desktopDir, "package.json"))("electron")
  const launchedPid = startDetached(
    electron,
    [desktopDir, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${paths.userData}`],
    env,
    paths.electronLog,
  )
  const run: RunState = {
    id,
    cdpPort,
    github: fakeBackend ? "fake" : github,
    backend: options.backend,
    ...(fake === undefined ? {} : { fake }),
    ...(fakePi === undefined ? {} : { fakePi }),
    ...(fakeAnthropic === undefined ? {} : { fakeAnthropic }),
  }
  saveRun(run)

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (!isAlive(launchedPid)) {
      console.error(readFileSync(paths.electronLog, "utf8").split("\n").slice(-30).join("\n"))
      return fail(`Electron exited during startup; run \`stop --run ${id}\` to clean up`)
    }
    const page = await tryOpenWindow(run)
    if (page) {
      const { endpoint, failure } = await backendState(page, 5000)
      page.close()
      if (failure) {
        if (options.failBackendStart) {
          console.log(`Ready: run ${id} (CDP port ${cdpPort}, backend failed to start as asked)`)
          return console.log(`Evidence goes to ${paths.evidence}`)
        }
        return fail(
          `the backend failed (${failure.kind}): ${failure.message}; see ${paths.backendLog}, then run \`stop --run ${id}\``,
        )
      }
      if (endpoint && (await backendHealthy(endpoint))) {
        run.backendUrl = endpoint.url
        saveRun(run)
        console.log(`Ready: run ${id} (CDP port ${cdpPort}, backend ${endpoint.url})`)
        return console.log(`Evidence goes to ${paths.evidence}`)
      }
    }
    await sleep(100)
  }
  return fail(`Glass did not become ready in 60s; see ${paths.electronLog}`)
}

const doctor = async (run: RunState) => {
  let ok = true
  const check = (pass: boolean, label: string, detail = "") => {
    ok &&= pass
    console.log(`${pass ? "OK  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`)
  }
  console.log(`Run ${run.id} (backend: ${run.backend}, github: ${run.backend === "fake" ? "fake, backend-owned" : run.github})`)
  console.log(`Tour provider: ${run.backend === "fake" ? "synthetic runners" : run.fakePi === undefined ? "real" : "fake (pi; Claude Code disabled)"}`)
  const pid = glassPid(run)
  check(pid !== undefined, "Electron process", `pid ${pid ?? "none"}`)
  const version = await cdpJson(
    `http://127.0.0.1:${run.cdpPort}/json/version`,
    Schema.Struct({ "User-Agent": Schema.String }),
  ).catch(() => undefined)
  const electronVersion = version?.["User-Agent"].match(/Electron\/(\S+)/)?.[1]
  check(
    electronVersion !== undefined,
    "CDP port is our Electron",
    `${run.cdpPort} ${electronVersion ?? ""}`,
  )
  const page = await tryOpenWindow(run)
  check(page !== undefined, "Window shows the built renderer", RENDERER_URL)
  if (page) {
    const { endpoint, failure } = await backendState(page)
    page.close()
    check(
      endpoint !== undefined && (await backendHealthy(endpoint)),
      "Backend health",
      failure ? `failed (${failure.kind}): ${failure.message}` : (endpoint?.url ?? "not up"),
    )
  }
  if (run.fake !== undefined) {
    check(
      isAlive(run.fake.pid),
      "Fake GitHub",
      `port ${run.fake.port}, mode ${readFileSync(runPaths(run.id).fakeModeFile, "utf8")}`,
    )
  }
  if (run.fakePi !== undefined) {
    check(
      isAlive(run.fakePi.pid) && (await portIsOpen(run.fakePi.port)),
      "Fake Pi provider",
      `port ${run.fakePi.port}`,
    )
  }
  if (run.fakeAnthropic !== undefined) {
    check(
      isAlive(run.fakeAnthropic.pid) && (await portIsOpen(run.fakeAnthropic.port)),
      "Fake Anthropic API",
      `port ${run.fakeAnthropic.port}`,
    )
  }
  const newestSource = Math.max(
    ...["apps/server/src", "apps/desktop/src", "packages/contracts/src"].flatMap(
      (dir) =>
        readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && !/\.test\.tsx?$/.test(entry.name))
          .map((entry) => statSync(join(entry.parentPath, entry.name)).mtimeMs),
    ),
  )
  const oldestBuild = Math.min(
    ...[
      "apps/server/dist/bin.mjs",
      "apps/server/dist/agentHost.mjs",
      "apps/desktop/dist/renderer/index.html",
      "apps/desktop/dist/main/index.cjs",
      "apps/desktop/dist/preload/index.cjs",
    ].map((file) => (existsSync(join(root, file)) ? statSync(join(root, file)).mtimeMs : 0)),
  )
  check(oldestBuild >= newestSource, "Build is newer than every source file")
  if (!ok) process.exit(1)
}

const glassRunning = (run: RunState) => portIsOpen(run.cdpPort)

const quitGlass = async (run: RunState) => {
  const deadline = Date.now() + 15_000
  let backendUrl = run.backendUrl
  let goneSince: number | undefined
  while (Date.now() < deadline) {
    const page = await tryOpenWindow(run)
    if (page) {
      const { endpoint } = await backendState(page)
      backendUrl = endpoint?.url ?? backendUrl
      page.fire("Browser.close")
      page.close()
    }
    if (await glassRunning(run)) goneSince = undefined
    else if (Date.now() - (goneSince ??= Date.now()) >= 2000) return { quit: true, backendUrl }
    await sleep(200)
  }
  return { quit: false, backendUrl }
}

const stop = async (run: RunState) => {
  const paths = runPaths(run.id)
  const { quit, backendUrl } = await quitGlass(run)
  if (!quit) {
    console.log("Electron did not quit; killing its process tree")
    const pid = glassPid(run)
    if (pid !== undefined) killTree(pid)
    await sleep(1000)
    if (await glassRunning(run)) return fail(`Glass is still running (pid ${pid}); run state kept`)
  }
  if (run.fake !== undefined) killTree(run.fake.pid)
  if (run.fakePi !== undefined) killTree(run.fakePi.pid)
  if (run.fakeAnthropic !== undefined) killTree(run.fakeAnthropic.pid)
  if (backendUrl) {
    const port = Number(new URL(backendUrl).port)
    for (let attempt = 0; attempt < 50 && (await portIsOpen(port)); attempt++) await sleep(100)
    console.log(`Backend port ${port}: ${(await portIsOpen(port)) ? "STILL OPEN" : "closed"}`)
  }
  mkdirSync(paths.evidence, { recursive: true })
  for (const log of [
    paths.electronLog,
    paths.backendLog,
    join(paths.state, "fake-github.log"),
    join(paths.state, "fake-pi.log"),
    join(paths.state, "fake-anthropic.log"),
  ]) {
    if (existsSync(log)) copyFileSync(log, join(paths.evidence, basename(log)))
  }
  rmSync(paths.state, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  console.log(`Stopped run ${run.id}. Evidence kept in ${paths.evidence}`)
}

const waitForText = async (run: RunState, text: string, timeout: number) => {
  const deadline = Date.now() + timeout
  let page: Cdp | undefined
  try {
    while (Date.now() < deadline) {
      try {
        page ??= await tryOpenWindow(run)
        if (
          page &&
          (await page.evaluate("document.body.innerText", Schema.String)).includes(text)
        ) {
          return console.log(`Found "${text}"`)
        }
      } catch {
        page?.close()
        page = undefined
      }
      await sleep(100)
    }
  } finally {
    page?.close()
  }
  return fail(`"${text}" did not appear within ${timeout}ms`)
}

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      run: { type: "string" },
      github: { type: "string", default: "real" },
      "fake-mode": { type: "string", default: "ok" },
      "tour-provider": { type: "string", default: "fake" },
      "no-credentials": { type: "boolean", default: false },
      "fail-backend-start": { type: "boolean", default: false },
      "no-build": { type: "boolean", default: false },
      backend: { type: "string", default: "real" },
      key: { type: "string" },
      meta: { type: "boolean", default: false },
      role: { type: "string" },
      name: { type: "string" },
      text: { type: "string" },
      timeout: { type: "string", default: "15000" },
      samples: { type: "string", default: "30" },
      interval: { type: "string", default: "1000" },
      sweep: { type: "boolean", default: false },
      dwell: { type: "string", default: "4" },
      gc: { type: "boolean", default: false },
      out: { type: "string" },
      by: { type: "string" },
      x: { type: "string" },
      y: { type: "string" },
    },
  })
  const [command, arg] = positionals

  switch (command) {
    case "__fake-github":
      return serveFakeGitHub(
        arg ?? fail("missing mode file"),
        positionals[2] ?? fail("missing ready file"),
      )
    case "__fake-anthropic":
      return serveFakeAnthropic(arg ?? fail("missing ready file"))
    case "__fake-pi":
      return serveFakePi(arg ?? fail("missing home"), positionals[2] ?? fail("missing ready file"))
    case "launch":
      return launch({
        github: values.github,
        fakeMode: values["fake-mode"],
        tourProvider: values["tour-provider"],
        noCredentials: values["no-credentials"],
        failBackendStart: values["fail-backend-start"],
        backend: values.backend,
        noBuild: values["no-build"],
        ...(values.run === undefined ? {} : { run: values.run }),
      })
    case "list":
      return console.log(liveRuns().join("\n") || "(no live runs)")
    case undefined:
    case "help":
      return console.log(USAGE)
  }

  const run = loadRun(values.run)
  switch (command) {
    case "doctor":
      return doctor(run)
    case "stop":
      return stop(run)
    case "fake-github": {
      if (run.backend === "fake") fail("this backend owns its fake GitHub; launch with --github fake to control GitHub modes")
      if (run.github !== "fake") fail("this run uses real GitHub; launch with --github fake")
      if (!isFakeMode(arg)) return fail(`mode is one of ${FAKE_MODES.join(", ")}`)
      writeFileSync(runPaths(run.id).fakeModeFile, arg)
      return console.log(`Fake GitHub now answers: ${arg}`)
    }
  }

  if (command === "wait") {
    return waitForText(run, values.text ?? fail("wait needs --text"), Number(values.timeout))
  }

  const page = await openWindow(run)
  try {
    switch (command) {
      case "kill-backend": {
        const { endpoint } = await backendState(page)
        const port = Number(new URL(endpoint?.url ?? fail("the backend is not up")).port)
        const pid = listenerPid(port) ?? fail(`nothing is listening on backend port ${port}`)
        killTree(pid)
        return console.log(`Killed backend pid ${pid} (port ${port})`)
      }
      case "text":
        return console.log(await page.evaluate("document.body.innerText", Schema.String))
      case "scroll": {
        const by = Number(values.by)
        if (!Number.isFinite(by) || by === 0) fail("scroll needs --by <pixels>")
        const x = Number(values.x ?? 800)
        const y = Number(values.y ?? 400)
        await page.send("Input.dispatchMouseEvent", EmptyResponse, {
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY: by,
        })
        return console.log(`Scrolled by ${by}px at ${x},${y}`)
      }
      case "memory": {
        const samples = Number(values.samples)
        const interval = Number(values.interval)
        const dwell = Number(values.dwell)
        if (!Number.isInteger(samples) || samples < 1) fail("--samples is a positive integer")
        if (!Number.isFinite(interval) || interval < 0) fail("--interval is milliseconds")
        if (values.sweep && (!Number.isInteger(dwell) || dwell < 1))
          fail("--dwell is a positive integer")
        const name =
          values.out ?? `memory-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`
        const file = join(evidenceDir(run), `${name}.jsonl`)
        writeFileSync(file, "")
        const sampler = await startSampler(page, glassPid(run))
        const started = Date.now()
        const collected: Array<MemorySample> = []
        let seq = 0
        const record = async (label?: string) => {
          if (values.gc) await page.send("HeapProfiler.collectGarbage", Schema.Struct({}))
          const sample = await sampler.sample(++seq, label)
          collected.push(sample)
          writeFileSync(file, `${JSON.stringify(sample)}\n`, { flag: "a" })
          process.stdout.write(".")
        }
        try {
          if (values.sweep) {
            const areas = ["Dashboard", "Reviews", "To-dos", "Agents", "Activity", "Settings"]
            for (const [index, area] of [...areas, "Dashboard"].entries()) {
              const label = index === areas.length ? "Dashboard again" : area
              await clickElement(page, "link", area)
              console.log(`\n${label}: settling`)
              await sleep(2000)
              for (let taken = 0; taken < dwell; taken++) {
                if (taken > 0) await sleep(interval)
                await record(label)
              }
            }
          } else {
            for (let taken = 1; taken <= samples; taken++) {
              const wait = started + (taken - 1) * interval - Date.now()
              if (wait > 0) await sleep(wait)
              await record()
            }
          }
        } finally {
          sampler.close()
        }
        process.stdout.write("\n")
        return console.log(
          values.sweep
            ? formatAreas(collected, file, Date.now() - started)
            : formatSummary(collected, file, Date.now() - started),
        )
      }
      case "snapshot": {
        if (!arg) fail("snapshot needs a name")
        const tree = formatAxTree(await axTree(page))
        writeFileSync(join(evidenceDir(run), `${arg}.aria.txt`), `${tree}\n`)
        return console.log(tree)
      }
      case "screenshot": {
        if (!arg) fail("screenshot needs a name")
        const { data } = await page.send(
          "Page.captureScreenshot",
          Schema.Struct({ data: Schema.String }),
          {
            format: "png",
          },
        )
        const file = join(evidenceDir(run), `${arg}.png`)
        writeFileSync(file, Buffer.from(data, "base64"))
        return console.log(file)
      }
      case "click": {
        const { role, name } = values
        if (!role || !name) fail("click needs --role and --name")
        await clickElement(page, role!, name!)
        return console.log(`Clicked ${role} "${name}"`)
      }
      case "type": {
        const { role, name, text } = values
        if (!role || !name || text === undefined) fail("type needs --role, --name and --text")
        await clickElement(page, role!, name!)
        await page.send("Input.dispatchKeyEvent", EmptyResponse, {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          modifiers: 2,
          commands: ["selectAll"],
        })
        await page.send("Input.dispatchKeyEvent", EmptyResponse, {
          type: "keyUp",
          key: "a",
          code: "KeyA",
        })
        await page.send("Input.insertText", EmptyResponse, { text })
        return console.log(`Typed into ${role} "${name}"`)
      }
      case "press": {
        const { key, meta } = values
        if (!key) fail("press needs --key")
        const pressed = { key, code: key, modifiers: meta ? 4 : 0 }
        await page.send("Input.dispatchKeyEvent", EmptyResponse, { type: "rawKeyDown", ...pressed })
        await page.send("Input.dispatchKeyEvent", EmptyResponse, { type: "keyUp", ...pressed })
        return console.log(`Pressed ${meta ? "⌘" : ""}${key}`)
      }
      default:
        return fail(`unknown command ${command}\n\n${USAGE}`)
    }
  } finally {
    page.close()
  }
}

await main()
