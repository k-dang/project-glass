import { ChildProcess } from "effect/process"
import { readFileSync, statSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

const thisHost = { platform: globalThis.process.platform, env: globalThis.process.env }

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false

const isScript = (path: string) => /\.(cmd|bat)$/i.test(path)

// Node finds only .exe and .com files on Windows, so npm's .cmd shims need this PATH search.
const resolve = (command: string, host: typeof thisHost) => {
  if (host.platform !== "win32") return command

  const extensions = (host.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  const names = extname(command) === "" ? extensions.map((ext) => command + ext) : [command]
  const folders = /[\\/]/.test(command) ? [""] : (host.env["PATH"] ?? "").split(";").filter(Boolean)

  return (
    folders.flatMap((folder) => names.map((name) => join(folder, name))).find(isFile) ?? command
  )
}

// cmd.exe parses a .cmd's arguments twice, once for the command line and once when the script
// expands them, so metacharacters are escaped twice, as cross-spawn does.
const metacharacters = /([()\][%!^"`<>&|;, *?])/g

const escapeArgument = (argument: string) =>
  `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`
    .replace(metacharacters, "^$1")
    .replace(metacharacters, "^$1")

export const launchCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: ChildProcess.CommandOptions = {},
  host = thisHost,
) => {
  if (/\.[cm]?js$/i.test(command))
    return ChildProcess.make(globalThis.process.execPath, [command, ...args], {
      ...options,
      env: { ELECTRON_RUN_AS_NODE: "1", ...options.env },
    })

  const resolved = resolve(command, host)

  if (!isScript(resolved)) return ChildProcess.make(resolved, args, options)

  const line = [resolved.replace(metacharacters, "^$1"), ...args.map(escapeArgument)].join(" ")

  return ChildProcess.make(line, [], { ...options, shell: true })
}

// The Claude Agent SDK spawns without a shell, so an npm shim is followed to the file it runs.
export const sdkExecutable = (command: string, host = thisHost) => {
  const resolved = resolve(command, host)

  if (!isScript(resolved)) return resolved

  const target = /"%dp0%\\([^"]+)"\s+%\*/.exec(readFileSync(resolved, "utf8"))?.[1]

  return target === undefined ? command : join(dirname(resolved), target)
}

export const bundledEntry = (name: string, callerUrl: string) =>
  fileURLToPath(
    new URL(callerUrl.endsWith(".ts") ? `../dist/${name}.mjs` : `./${name}.mjs`, callerUrl),
  )
