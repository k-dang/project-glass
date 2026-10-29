import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, watch } from "node:fs"
import { createRequire } from "node:module"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")

const desktopDir = join(root, "apps", "desktop")

const isWindows = process.platform === "win32"

const pnpmPath = process.env["npm_execpath"]

if (!pnpmPath) throw new Error("Start the dev launcher with pnpm dev")

/** `--fake` runs the backend on a fake GitHub and Tour runners, with data in a fresh directory. */
const fake = process.argv.includes("--fake")

const outputs = [
  join(desktopDir, "dist", "main", "index.cjs"),
  join(desktopDir, "dist", "preload", "index.cjs"),
  fake
    ? join(root, "apps", "server", "dist-fake", "fakeBackend.mjs")
    : join(root, "apps", "server", "dist", "bin.mjs"),
]

const children = new Set<ChildProcess>()

const start = (command: string, args: Array<string>, env: NodeJS.ProcessEnv = process.env) => {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    // POSIX detached children lead a new process group, addressable by -pid.
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

  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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

for (const file of outputs) rmSync(file, { force: true })

start(process.execPath, [
  pnpmPath,
  "--filter",
  "@glass/desktop",
  "dev:renderer",
  "--port",
  String(RENDERER_PORT),
])

start(process.execPath, [pnpmPath, "--filter", "@glass/server", "dev"])

start(process.execPath, [pnpmPath, "--filter", "@glass/desktop", "dev"])

await waitFor("the Vite dev server", () => portIsOpen(RENDERER_PORT))

await waitFor("the first builds", () => outputs.every((file) => existsSync(file)))

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

const launchElectron = () => {
  if (shuttingDown) return

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
    if (!outputs.every((file) => existsSync(file))) return
    console.log("[dev] Rebuilt; restarting Electron")
    const previous = electron
    electron = undefined

    if (previous) stopTree(previous)
    launchElectron()
  }, 300)
}

for (const dir of new Set(outputs.map((file) => join(file, "..")))) {
  watch(dir, (_event, filename) => {
    if (filename !== null && outputs.some((file) => file.endsWith(filename))) scheduleRestart()
  })
}

launchElectron()
