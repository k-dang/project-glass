import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isolatedHome } from "../test/harness"
import { launchCommand, sdkExecutable } from "./processes"

const installShim = (folder: string, name: string, target: string, runner = "") =>
  Effect.promise(() =>
    writeFile(
      join(folder, `${name}.cmd`),
      `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nendLocal & ${runner} "%dp0%\\${target}" %*\r\n`,
    ),
  )

const windowsHost = (folder: string) => ({
  platform: "win32" as const,
  env: { PATH: folder, PATHEXT: ".EXE;.CMD" },
})

it.live.skipIf(process.platform !== "win32")(
  "runs an npm .cmd shim found on PATH with its arguments intact",
  () =>
    Effect.gen(function* () {
      const folder = yield* isolatedHome
      yield* installShim(folder, "agent", "cli.js", `"${process.execPath}"`)
      yield* Effect.promise(() =>
        writeFile(
          join(folder, "cli.js"),
          "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
        ),
      )

      const args = [
        "--mode",
        "rpc",
        "two words",
        'a "quote"',
        "a&b|c",
        "100%",
        "^caret!",
        "C:\\dir\\",
      ]

      const child = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
        launchCommand("agent", args, {}, windowsHost(folder)),
      )

      const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)

      assert.deepStrictEqual(JSON.parse(output), args)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live("follows an npm shim on the Windows PATH to the file the Claude SDK runs", () =>
  Effect.gen(function* () {
    const folder = yield* isolatedHome
    yield* installShim(folder, "claude", "bin\\claude.exe")

    const executable = sdkExecutable("claude", windowsHost(folder))

    assert.strictEqual(executable, join(folder, "bin\\claude.exe"))
  }),
)
