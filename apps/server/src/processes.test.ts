import { NodeServices } from "@effect/platform-node"
import { assert, it, vi } from "@effect/vitest"
import { Effect, Predicate, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { isolatedHome } from "../test/harness"
import { argumentLength, launchCommand, sdkExecutable } from "./processes"

const installShim = (folder: string, name: string, target: string, runner = "") =>
  Effect.promise(() =>
    writeFile(
      join(folder, `${name}.cmd`),
      `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nendLocal & ${runner} "%dp0%\\${target}" %*\r\n`,
    ),
  )

const windowsHost = (folder: string) => ({
  platform: "win32" as const,
  env: { PATH: folder, PATHEXT: ".exe;.cmd" },
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

it.live.skipIf(process.platform !== "win32")(
  "never runs a same-named program from the working folder when the command isn't on PATH",
  () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const checkout = join(home, "checkout")
      yield* Effect.promise(() => mkdir(checkout))
      yield* Effect.promise(() =>
        copyFile("C:\\Windows\\System32\\whoami.exe", join(checkout, "agent.exe")),
      )
      vi.stubEnv("NoDefaultCurrentDirectoryInExePath", undefined)

      const error = yield* Effect.flip(
        (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
          launchCommand("agent", [], { cwd: checkout }, windowsHost(home)),
        ),
      )

      assert.isTrue(Predicate.isTagged(error.reason, "NotFound"))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live("hands the Claude SDK a full path when the command isn't on the Windows PATH", () =>
  Effect.gen(function* () {
    const folder = yield* isolatedHome

    assert.isTrue(isAbsolute(sdkExecutable("claude", windowsHost(folder))))
  }),
)

it.live("finds a command in a quoted Windows PATH folder", () =>
  Effect.gen(function* () {
    const folder = yield* isolatedHome
    yield* installShim(folder, "claude", "bin\\claude.exe")

    const executable = sdkExecutable("claude", windowsHost(`"${folder}"`))

    assert.strictEqual(executable, join(folder, "bin\\claude.exe"))
  }),
)

it.live("refuses a line break in an argument to a .cmd shim, which cmd.exe would cut off", () =>
  Effect.gen(function* () {
    const folder = yield* isolatedHome
    yield* installShim(folder, "agent", "cli.js")

    for (const argument of ["line one\nline two", "line one\rline two"])
      assert.throws(
        () => launchCommand("agent", ["--a", argument, "--after"], {}, windowsHost(folder)),
        /line break/,
      )
  }),
)

it.live("measures an argument as the launched process receives it", () =>
  Effect.gen(function* () {
    const folder = yield* isolatedHome
    yield* installShim(folder, "claude", "cli.js")
    const argument = '{"a":1}'

    assert.deepStrictEqual(
      [
        argumentLength("claude", argument, { platform: "linux", env: {} }),
        argumentLength("claude.exe", argument, windowsHost(folder)),
        argumentLength("claude", argument, windowsHost(folder)),
      ],
      [7, '"{\\"a\\":1}"'.length, '^^^"{\\^^^"a\\^^^":1}^^^"'.length],
    )
  }),
)

it.live("follows an npm shim on the Windows PATH to the file the Claude SDK runs", () =>
  Effect.gen(function* () {
    const folder = yield* isolatedHome
    yield* installShim(folder, "claude", "bin\\claude.exe")

    const executable = sdkExecutable("claude", windowsHost(folder))

    assert.strictEqual(executable, join(folder, "bin\\claude.exe"))
  }),
)

it.live("follows a pi.dev shim on the Windows PATH to its launcher script", () =>
  Effect.gen(function* () {
    const folder = yield* isolatedHome
    yield* Effect.promise(() =>
      writeFile(
        join(folder, "pi.cmd"),
        `@ECHO off\r\nSETLOCAL\r\nSET "node=node"\r\n"%node%" "%~dp0pi-launcher.js" %*\r\n`,
      ),
    )

    const executable = sdkExecutable("pi", windowsHost(folder))

    assert.strictEqual(executable, join(folder, "pi-launcher.js"))
  }),
)
