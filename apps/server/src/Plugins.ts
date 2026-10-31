import { AgentEngine } from "@glass/contracts"
import type { Glass, Plugin, SandboxProvider } from "@glass/plugin"
import { Context, Effect, FileSystem, Layer, Option, Predicate, Result, Schema } from "effect"
// The static entry imports jiti's TypeScript transform, so it lands in the backend's bundle.
import { createJiti } from "jiti/static"
import { extname, join } from "node:path"
import { ServerConfig } from "./ServerConfig"
import { MissingLogin, NoCapacity } from "./sandboxFailures"

const pluginFile = new Set([".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"])

interface PluginPath {
  readonly path: string
  readonly isFolder: boolean
}

const pluginPaths = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, directory: string) {
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))

  const paths: Array<PluginPath> = []

  for (const name of names.toSorted((a, b) => a.localeCompare(b))) {
    const path = join(directory, name)
    const info = yield* fs.stat(path).pipe(Effect.option)

    if (Option.isNone(info)) continue

    const isFolder = info.value.type === "Directory"

    if (isFolder || (info.value.type === "File" && pluginFile.has(extname(name))))
      paths.push({ path, isFolder })
  }

  return paths
})

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ glass: Schema.optional(Schema.String) })),
)

const entryOf = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  { path, isFolder }: PluginPath,
) {
  if (!isFolder) return path

  const manifest = yield* fs.readFileString(join(path, "package.json")).pipe(
    Effect.map((text) => Option.getOrUndefined(decodeManifest(text))),
    Effect.orElseSucceed(() => undefined),
  )

  if (manifest?.glass !== undefined) return join(path, manifest.glass)

  const files = yield* fs.readDirectory(path)

  return join(path, files.includes("index.ts") ? "index.ts" : "index.js")
})

const validProviderId = /^[a-z0-9][a-z0-9-]*$/

const validEngines = Schema.is(Schema.NonEmptyArray(AgentEngine))

const loadPlugin = (
  fs: FileSystem.FileSystem,
  plugin: PluginPath,
  jiti: ReturnType<typeof createJiti>,
) =>
  Effect.gen(function* () {
    const entry = yield* entryOf(fs, plugin)

    const factory = yield* Effect.tryPromise(async () => {
      const exported = await jiti.import(entry, { default: true })

      if (!Predicate.isFunction(exported)) throw new Error("Its default export isn't a function")

      // SAFETY: a Plugin's default export is its factory (ADR 0008); a non-function is refused above.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- See SAFETY above.
      return exported as Plugin
    })

    const registered = new Map<string, SandboxProvider>()

    const glass: Glass = {
      registerSandboxProvider: (id, provider) => void registered.set(id, provider),
      missingLogin: (login, fix) => new MissingLogin(login, fix),
      noCapacity: (message) => new NoCapacity(message),
    }

    yield* Effect.tryPromise(async () => factory(glass)).pipe(Effect.timeout("10 seconds"))

    return registered
  })

export class Plugins extends Context.Service<
  Plugins,
  { readonly sandboxProviders: ReadonlyMap<string, SandboxProvider> }
>()("@glass/server/Plugins") {
  static readonly layerFrom = (directory: string) =>
    Layer.effect(
      Plugins,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const jiti = createJiti(import.meta.url, { moduleCache: false })

        const loaded = yield* Effect.forEach(
          yield* pluginPaths(fs, directory),
          (plugin) =>
            loadPlugin(fs, plugin, jiti).pipe(
              Effect.result,
              Effect.map((result) => ({ path: plugin.path, result })),
            ),
          { concurrency: "unbounded" },
        )

        const sandboxProviders = new Map<string, SandboxProvider>()

        for (const { path, result } of loaded) {
          if (Result.isFailure(result)) {
            yield* Effect.logWarning("Couldn't load a Plugin", path, result.failure)
            continue
          }

          for (const [id, provider] of result.success) {
            if (!validProviderId.test(id)) {
              yield* Effect.logWarning(
                "Skipped a Sandbox provider whose id isn't lowercase letters, digits, and dashes",
                id,
                path,
              )
            } else if (!validEngines(provider.engines)) {
              yield* Effect.logWarning(
                "Skipped a Sandbox provider that doesn't list the Agent programs it runs",
                id,
                path,
              )
            } else if (sandboxProviders.has(id)) {
              yield* Effect.logWarning("Skipped a Sandbox provider already registered", id, path)
            } else {
              sandboxProviders.set(id, provider)
            }
          }
        }

        return Plugins.of({ sandboxProviders })
      }),
    )

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const { dataDirectory } = yield* ServerConfig

      return Plugins.layerFrom(join(dataDirectory, "plugins"))
    }),
  )
}
