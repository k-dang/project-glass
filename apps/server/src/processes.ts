import { fileURLToPath } from "node:url"

export const commandLine = (command: string, args: ReadonlyArray<string>) =>
  /\.[cm]?js$/i.test(command)
    ? {
        executable: globalThis.process.execPath,
        args: [command, ...args],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      }
    : { executable: command, args: [...args], env: {} }

export const bundledEntry = (name: string, callerUrl: string) =>
  fileURLToPath(
    new URL(callerUrl.endsWith(".ts") ? `../dist/${name}.mjs` : `./${name}.mjs`, callerUrl),
  )
