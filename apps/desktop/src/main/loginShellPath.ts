import { Effect } from "effect"
import { execFile } from "node:child_process"

const MARKER = "__GLASS_PATH__"

const TIMEOUT_MS = 5_000

const readPath = (shell: string) =>
  Effect.promise(
    () =>
      new Promise<string | undefined>((resolve) => {
        const child = execFile(
          shell,
          // Interactive and login, so both profile and rc files run. The markers fence the
          // PATH off from anything those files print.
          ["-ilc", `printf '${MARKER}%s${MARKER}' "$PATH"`],
          { encoding: "utf8", timeout: TIMEOUT_MS },
          (_error, stdout) => resolve(stdout.split(MARKER)[1] || undefined),
        )

        child.stdin?.end()
      }),
  )

const mergePaths = (...paths: ReadonlyArray<string | undefined>) =>
  [
    ...new Set(
      paths.flatMap((path) => (path ?? "").split(":").map((entry) => entry.trim())).filter(Boolean),
    ),
  ].join(":")

/**
 * Apps opened from Finder or the Dock inherit launchd's bare PATH, which misses where
 * claude, pi, and git usually live (~/.local/bin, Homebrew, version managers). Prepends the
 * first PATH a login shell reports, and leaves PATH alone when none of the shells answer.
 */
export const installLoginShellPath = (
  env: NodeJS.ProcessEnv,
  shells: ReadonlyArray<string | undefined>,
) =>
  Effect.gen(function* () {
    for (const shell of new Set(shells)) {
      if (!shell) continue

      const path = yield* readPath(shell)

      if (path) {
        env["PATH"] = mergePaths(path, env["PATH"])

        return
      }
    }
  })
