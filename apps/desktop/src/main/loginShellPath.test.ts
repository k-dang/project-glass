import { Effect } from "effect"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
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
  it.live.skipIf(process.platform === "win32")(
    "prepends the shell's PATH, ignoring rc output and dropping duplicates",
    () =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory

        const shell = yield* fakeShell(
          directory,
          "zsh",
          'echo "Welcome back"\nPATH=/home/me/.local/bin:/usr/bin; export PATH',
        )

        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }

        yield* prependLoginShellPath(env, [shell])

        assert.strictEqual(env["PATH"], "/home/me/.local/bin:/usr/bin:/bin")
      }),
  )

  it.live.skipIf(process.platform === "win32")(
    "falls through shells that are missing or report nothing",
    () =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory
        const silent = yield* fakeShell(directory, "silent", "exit 1")

        const bash = yield* fakeShell(directory, "bash", "PATH=/opt/homebrew/bin; export PATH")

        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" }

        yield* prependLoginShellPath(env, [undefined, join(directory, "missing"), silent, bash])

        assert.strictEqual(env["PATH"], "/opt/homebrew/bin:/usr/bin")
      }),
  )

  it.live("keeps the inherited PATH when no shell answers", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }

      yield* prependLoginShellPath(env, ["/nonexistent/shell"])

      assert.strictEqual(env["PATH"], "/usr/bin:/bin")
    }),
  )
})
