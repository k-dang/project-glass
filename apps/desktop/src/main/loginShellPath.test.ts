import { Effect } from "effect"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vite-plus/test"
import { prependLoginShellPath } from "./loginShellPath"

const tempDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "glass-login-shell-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
)

const fakeShell = (directory: string, name: string, profile: string) =>
  Effect.promise(async () => {
    const path = join(directory, name)
    await writeFile(path, `#!/bin/sh\n${profile}\ncommand=$2\neval "$command"\n`)
    await chmod(path, 0o755)

    return path
  })

describe("login shell PATH", () => {
  it.skipIf(process.platform === "win32")(
    "prepends the shell's PATH, ignoring rc output and dropping duplicates",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const directory = yield* tempDirectory

          const shell = yield* fakeShell(
            directory,
            "zsh",
            'echo "Welcome back"\nPATH=/home/me/.local/bin:/usr/bin; export PATH',
          )

          const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }

          yield* prependLoginShellPath(env, [shell])

          expect(env["PATH"]).toBe("/home/me/.local/bin:/usr/bin:/bin")
        }).pipe(Effect.scoped),
      ),
  )

  it.skipIf(process.platform === "win32")(
    "falls through shells that are missing or report nothing",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const directory = yield* tempDirectory
          const silent = yield* fakeShell(directory, "silent", "exit 1")

          const bash = yield* fakeShell(directory, "bash", "PATH=/opt/homebrew/bin; export PATH")

          const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" }

          yield* prependLoginShellPath(env, [undefined, join(directory, "missing"), silent, bash])

          expect(env["PATH"]).toBe("/opt/homebrew/bin:/usr/bin")
        }).pipe(Effect.scoped),
      ),
  )

  it("keeps the inherited PATH when no shell answers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }

        yield* prependLoginShellPath(env, ["/nonexistent/shell"])

        expect(env["PATH"]).toBe("/usr/bin:/bin")
      }),
    ))
})
