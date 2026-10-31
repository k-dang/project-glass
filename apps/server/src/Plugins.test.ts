import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Logger, Schema } from "effect"
import { TestClock } from "effect/testing"
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isolatedHome } from "../test/harness"
import { Plugins } from "./Plugins"

const providerPlugin = (id: string, engines: ReadonlyArray<string> = ["pi"]) => `
export default (glass) => {
  glass.registerSandboxProvider(${JSON.stringify(id)}, {
    engines: ${JSON.stringify(engines)},
    create: async () => {},
    target: async () => ({ url: "http://sandbox", headers: {} }),
    remove: async () => {},
    models: async () => ({ defaultModel: null, models: [] }),
  })
}
`

const write = (path: string, contents: string) =>
  Effect.promise(async () => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  })

const loadPlugins = (directory: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Plugins.layerFrom(directory).pipe(Layer.provide(NodeServices.layer)),
    )

    return [...Context.get(context, Plugins).sandboxProviders.keys()]
  })

describe("Plugins", () => {
  it.live("registers the Sandbox provider of a plugin file", () =>
    Effect.gen(function* () {
      const plugins = yield* isolatedHome
      yield* write(join(plugins, "fake.js"), providerPlugin("fake"))

      assert.deepStrictEqual(yield* loadPlugins(plugins), ["fake"])
    }),
  )

  it.live("skips a Sandbox provider that doesn't list Agent programs Glass knows", () =>
    Effect.gen(function* () {
      const plugins = yield* isolatedHome
      yield* write(join(plugins, "empty.js"), providerPlugin("empty", []))
      yield* write(join(plugins, "unknown.js"), providerPlugin("unknown", ["pi", "codex"]))
      yield* write(
        join(plugins, "null.js"),
        `export default (glass) => glass.registerSandboxProvider("null", null)`,
      )
      yield* write(join(plugins, "valid.js"), providerPlugin("valid"))

      assert.deepStrictEqual(yield* loadPlugins(plugins), ["valid"])
    }),
  )

  it.live("loads a TypeScript folder plugin that imports from its own node_modules", () =>
    Effect.gen(function* () {
      const plugins = yield* isolatedHome
      const folder = join(plugins, "typed")
      yield* write(
        join(folder, "node_modules", "provider-id", "package.json"),
        JSON.stringify({ name: "provider-id", main: "index.js" }),
      )
      yield* write(join(folder, "node_modules", "provider-id", "index.js"), `exports.id = "typed"`)
      yield* write(
        join(folder, "index.ts"),
        `import { id } from "provider-id"
type Glass = { registerSandboxProvider: (id: string, provider: unknown) => void }
export default (glass: Glass): void => {
  glass.registerSandboxProvider(id, { engines: ["pi"] } as unknown)
}
`,
      )

      assert.deepStrictEqual(yield* loadPlugins(plugins), ["typed"])
    }),
  )

  it.live("starts a folder plugin at the entry its package.json names under glass", () =>
    Effect.gen(function* () {
      const plugins = yield* isolatedHome
      const folder = join(plugins, "packaged")
      yield* write(join(folder, "package.json"), JSON.stringify({ glass: "src/plugin.js" }))
      yield* write(join(folder, "src", "plugin.js"), providerPlugin("packaged"))

      assert.deepStrictEqual(yield* loadPlugins(plugins), ["packaged"])
    }),
  )

  it.live("follows a symlink to a plugin folder kept elsewhere", () =>
    Effect.gen(function* () {
      const plugins = yield* isolatedHome
      const elsewhere = yield* isolatedHome
      yield* write(join(elsewhere, "index.js"), providerPlugin("linked"))
      yield* Effect.promise(() => symlink(elsewhere, join(plugins, "linked")))

      assert.deepStrictEqual(yield* loadPlugins(plugins), ["linked"])
    }),
  )

  it.effect("logs and skips plugins that fail, and still loads the rest", () =>
    Effect.gen(function* () {
      const plugins = yield* isolatedHome
      yield* write(join(plugins, "a-throws.js"), `export default () => { throw new Error("boom") }`)
      yield* write(join(plugins, "b-no-factory.js"), `export const value = 1`)
      yield* write(join(plugins, "c-fine.js"), providerPlugin("fine"))
      yield* write(join(plugins, "d-duplicate.js"), providerPlugin("fine"))
      yield* write(join(plugins, "e-bad-id.js"), providerPlugin("sandbox:Fine"))
      yield* write(join(plugins, "f-hangs.js"), `export default () => new Promise(() => {})`)
      yield* write(join(plugins, "g-unreadable", "index.js"), providerPlugin("unreadable"))
      yield* Effect.promise(() => chmod(join(plugins, "g-unreadable"), 0o000))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => chmod(join(plugins, "g-unreadable"), 0o700)),
      )
      const logged: Array<ReadonlyArray<unknown>> = []

      const logger = Logger.make(({ message }) => {
        logged.push(Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(message).slice(0, 2))
      })

      const passFactoryTimeouts = Effect.forever(
        TestClock.adjust("10 seconds").pipe(
          Effect.andThen(Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))),
        ),
      )

      const providers = yield* loadPlugins(plugins).pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.race(passFactoryTimeouts),
      )

      assert.deepStrictEqual(providers, ["fine"])
      assert.deepStrictEqual(logged, [
        ["Couldn't load a Plugin", join(plugins, "a-throws.js")],
        ["Couldn't load a Plugin", join(plugins, "b-no-factory.js")],
        ["Skipped a Sandbox provider already registered", "fine"],
        [
          "Skipped a Sandbox provider whose id isn't lowercase letters, digits, and dashes",
          "sandbox:Fine",
        ],
        ["Couldn't load a Plugin", join(plugins, "f-hangs.js")],
        ["Couldn't load a Plugin", join(plugins, "g-unreadable")],
      ])
    }),
  )

  it.live("has no Sandbox providers when the plugins folder doesn't exist", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome

      assert.deepStrictEqual(yield* loadPlugins(join(home, "plugins")), [])
    }),
  )
})
