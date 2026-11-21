import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
} from "node:fs"
import { createRequire } from "node:module"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stopAgentHost } from "../apps/server/test/stopAgentHost.ts"

const root = join(import.meta.dirname, "..")

const desktopDir = join(root, "apps", "desktop")

const serverDir = join(root, "apps", "server")

const isWindows = process.platform === "win32"

const pnpmPath = process.env["npm_execpath"]

if (!pnpmPath) throw new Error("Start the dev launcher with pnpm dev")

const fake = process.argv.includes("--fake")

const serverDist = join(serverDir, fake ? "dist-fake" : "dist")

const serverEntries = [fake ? "fakeBackend.mjs" : "bin.mjs", "sqlReadWorker.mjs", "agentHost.mjs"]

const serverInstalled = serverEntries.map((name) => join(serverDist, name))

const desktopOutputs = [
  join(desktopDir, "dist", "main", "index.cjs"),
  join(desktopDir, "dist", "preload", "index.cjs"),
]

const installed = [...desktopOutputs, ...serverInstalled]

const serverSources = [
  join(root, "pnpm-lock.yaml"),
  join(serverDir, "vite.config.ts"),
  join(serverDir, "src"),
  ...(fake ? [join(serverDir, "test")] : []),
  join(root, "packages", "contracts", "src"),
  join(root, "packages", "plugin", "src"),
]

const exist = (files: ReadonlyArray<string>) => files.every((file) => existsSync(file))

const lastChanged = (path: string): number => {
  const stats = statSync(path)

  if (!stats.isDirectory()) return stats.mtimeMs

  return Math.max(0, ...readdirSync(path).map((name) => lastChanged(join(path, name))))
}

const serverUpToDate =
  exist(serverInstalled) &&
  Math.max(...serverSources.map(lastChanged)) < Math.min(...serverInstalled.map(lastChanged))

// WARNING: Never rebuild reused server bundles in place. A backend that reads a half-written agentHost.mjs takes it for another build and shuts down the running agent host.
const serverBuild = serverUpToDate ? `${serverDist}-dev` : serverDist

const built = [...desktopOutputs, ...serverEntries.map((name) => join(serverBuild, name))]

const fingerprint = (files: ReadonlyArray<string>) => {
  const hash = createHash("sha256")

  for (const file of files) hash.update(readFileSync(file))

  return hash.digest("hex")
}

const empty = (dir: string) => {
  mkdirSync(dir, { recursive: true })

  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true })
}

const children = new Set<ChildProcess>()

const start = (command: string, args: Array<string>, env: NodeJS.ProcessEnv = process.env) => {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    detached: !isWindows,
  })

  children.add(child)
  child.once("close", () => children.delete(child))

  return child
}

const stopTree = (child: ChildProcess) => {
  if (child.exitCode !== null || child.pid === undefined) return

  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    process.kill(-child.pid, "SIGTERM")
  }
}

let shuttingDown = false

let fakeHome: string | undefined

let restartTimer: NodeJS.Timeout | undefined

const shutdown = async (code: number) => {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(restartTimer)

  await Promise.all(
    Array.from(
      children,
      (child) =>
        new Promise<void>((resolve) => {
          child.once("close", () => resolve())
          stopTree(child)
        }),
    ),
  )

  if (fakeHome) {
    await stopAgentHost(join(fakeHome, ".project-glass"))

    try {
      rmSync(fakeHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    } catch (error) {
      console.warn(`[dev] Could not remove ${fakeHome}: ${String(error)}`)
    }
  }

  process.exit(code)
}

process.on("SIGINT", () => void shutdown(0))

process.on("SIGTERM", () => void shutdown(0))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const portIsOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1")
    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })

const waitFor = async (what: string, ready: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await ready()) return
    await sleep(100)
  }

  console.error(`[dev] Timed out waiting for ${what}`)
  await shutdown(1)
}

const pickRendererPort = async () => {
  let hash = 0

  for (const char of root) hash = (hash * 31 + char.charCodeAt(0)) >>> 0

  for (let port = 5733 + (hash % 1000); ; port++) {
    if (!(await portIsOpen(port))) return port
  }
}

const RENDERER_PORT = await pickRendererPort()

const devServerUrl = `http://127.0.0.1:${RENDERER_PORT}`

const builtDirs = new Set(built.map((file) => join(file, "..")))

for (const dir of builtDirs) empty(dir)

start(process.execPath, [
  pnpmPath,
  "--filter",
  "@glass/desktop",
  "dev:renderer",
  "--port",
  String(RENDERER_PORT),
])

start(
  process.execPath,
  [pnpmPath, "--filter", "@glass/server", "dev", "--out-dir", serverBuild, "--no-clean"],
  { ...process.env, GLASS_PACK_BACKEND: fake ? "fake" : "real" },
)

start(process.execPath, [pnpmPath, "--filter", "@glass/desktop", "dev"])

await waitFor("the Vite dev server", () => portIsOpen(RENDERER_PORT))

await waitFor("the first builds", () => exist(installed))

const electronPath: string = createRequire(join(desktopDir, "package.json"))("electron")

const electronEnv: NodeJS.ProcessEnv = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl }

delete electronEnv["ELECTRON_RUN_AS_NODE"]

const electronArgs = [desktopDir]

if (fake) {
  fakeHome = mkdtempSync(join(tmpdir(), "glass-dev-fake-"))
  electronEnv["GLASS_FAKE_BACKEND"] = "1"
  electronEnv["GLASS_HOME"] = fakeHome
  electronArgs.push(`--user-data-dir=${join(fakeHome, "user-data")}`)
  console.log(`[dev] Fakes: GitHub and Tour runners; data in ${fakeHome}`)
}

let electron: ChildProcess | undefined

let launched: string | undefined

const launchElectron = () => {
  if (shuttingDown) return

  launched = fingerprint(installed)
  const child = start(electronPath, electronArgs, electronEnv)
  electron = child
  child.once("exit", (code) => {
    if (electron === child) {
      console.log(`[dev] Electron exited with code ${code}; stopping`)
      void shutdown(code ?? 0)
    }
  })
}

const scheduleRestart = () => {
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    if (!exist(built) || fingerprint(built) === launched) return

    console.log("[dev] Rebuilt; restarting Electron")
    const previous = electron
    electron = undefined

    if (previous) stopTree(previous)

    if (serverBuild !== serverDist) {
      empty(serverDist)
      cpSync(serverBuild, serverDist, { recursive: true })
    }

    launchElectron()
  }, 300)
}

for (const dir of builtDirs) {
  watch(dir, (_event, filename) => {
    if (filename !== null && built.some((file) => file.endsWith(filename))) scheduleRestart()
  })
}

launchElectron()

scheduleRestart()
