import { defineRule, type ESTree } from "vite-plus/lint/plugins"
import { isBuiltin } from "node:module"
import { ResolverFactory } from "oxc-resolver"
import { isTest, projectPath } from "./paths.ts"
import { importedPath, literalString } from "./imports.ts"

const resolver = new ResolverFactory({
  tsconfig: "auto",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
  extensionAlias: { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] },
  conditionNames: ["import", "node", "default"],
  builtinModules: true,
})

const transportOwners = new Set([
  "bin.ts",
  "server.ts",
  "handlers.ts",
  "access.ts",
  "agentHost.ts",
  "agentHost/handlers.ts",
  "agentHost/server.ts",
  "agentHost/serve.ts",
  "rpcSocket.ts",
  "LocalAgentHost.ts",
  "sandboxCalls.ts",
  "mcp/server.ts",
])

const entryPoints = new Set([
  "bin.ts",
  "server.ts",
  "handlers.ts",
  "access.ts",
  "agentHost.ts",
  "agentHost/handlers.ts",
  "agentHost/server.ts",
  "agentHost/serve.ts",
  "rpcSocket.ts",
  "mcp/server.ts",
])

const rpcContracts = new Set(["Rpc", "RpcGroup", "RpcSchema", "RpcMessage", "RpcClientError"])

const httpContracts = new Set(["HttpClientError", "HttpServerError", "HttpMethod"])

const mcpTransport = new Set(["McpServer", "McpProtocol"])

const httpClient = new Set([
  ...httpContracts,
  "FetchHttpClient",
  "HttpClient",
  "HttpClientRequest",
  "HttpClientResponse",
])

type ImportNode =
  | ESTree.ImportDeclaration
  | ESTree.ExportNamedDeclaration
  | ESTree.ExportAllDeclaration

function typeOnly(node: ImportNode): boolean {
  if (node.type !== "ImportDeclaration") return node.exportKind === "type"

  return (
    node.importKind === "type" ||
    (node.specifiers.length > 0 &&
      node.specifiers.every((s) => s.type === "ImportSpecifier" && s.importKind === "type"))
  )
}

function runtimeNames(node: ESTree.Node): ReadonlyArray<string> | null {
  if (
    (node.type !== "ImportDeclaration" && node.type !== "ExportNamedDeclaration") ||
    node.specifiers.length === 0
  )
    return null
  const names: Array<string> = []

  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportSpecifier") {
      if (specifier.importKind !== "type")
        names.push(
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value,
        )
    } else if (specifier.type === "ExportSpecifier") {
      if (specifier.exportKind !== "type")
        names.push(
          specifier.local.type === "Identifier" ? specifier.local.name : specifier.local.value,
        )
    } else return null
  }

  return names
}

function contractImport(node: ESTree.Node, allowed: ReadonlySet<string>): boolean {
  const names = runtimeNames(node)

  return names !== null && names.every((name) => allowed.has(name))
}

export const architecture = defineRule({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      renderer:
        "Renderer code uses @glass/contracts and its RPC client; do not import backend/main/preload implementations, test fixtures, Electron or Node builtins ({{target}}).",
      contracts:
        "Shared contracts cannot import app implementations or app test fixtures ({{target}}).",
      transport:
        "Keep backend logic independent of HTTP/RPC transport implementation ({{target}}). Use contracts or a service adapter; transport owners are listed in tools/oxlint/glass/architecture.ts.",
      standalone:
        "The verify-glass helper loads the fakes that import this file under plain Node, which can't resolve the server's extensionless imports, so it imports nothing ({{target}}).",
    },
  },
  create(context) {
    const filename = projectPath(context.filename)

    if (isTest(filename)) return {}
    const renderer = filename.startsWith("apps/desktop/src/renderer/")
    const contracts = filename.startsWith("packages/contracts/")
    const backend = filename.startsWith("apps/server/src/")

    if (!renderer && !contracts && !backend) return {}
    const backendFile = filename.slice("apps/server/src/".length)

    function check(node: ESTree.Node, specifier: string, onlyTypes = false) {
      const resolved = resolver.resolveFileSync(context.filename, specifier)
      const target = resolved.path ? projectPath(resolved.path) : specifier
      let messageId: "renderer" | "contracts" | "transport" | "standalone" | undefined

      if (
        renderer &&
        (isBuiltin(specifier) ||
          resolved.builtin ||
          specifier === "electron" ||
          target.startsWith("apps/server/") ||
          target.startsWith("apps/desktop/src/main/") ||
          target.startsWith("apps/desktop/src/preload/") ||
          isTest(target))
      )
        messageId = "renderer"

      if (contracts && target.startsWith("apps/")) messageId = "contracts"

      if (filename === "apps/server/src/gitEnv.ts" && !onlyTypes) messageId = "standalone"

      if (backend && !transportOwners.has(backendFile)) {
        const localTransport =
          target.startsWith("apps/server/src/") &&
          entryPoints.has(target.slice("apps/server/src/".length))

        const effectModule = target
          .replaceAll("\\", "/")
          .match(/\/effect\/(?:dist|src)\/(.+?)(?:\.js|\.ts)$/)?.[1]

        const rpc = effectModule === "rpc/index" || effectModule?.startsWith("rpc/")
        const http = effectModule?.startsWith("http/") || effectModule?.startsWith("http-api/")

        const platformModule = target.match(
          /\/@effect\/platform-node\/(?:dist|src)\/(.+?)(?:\.js|\.ts)$/,
        )?.[1]

        const names = runtimeNames(node)

        const platformHttp =
          platformModule === "index"
            ? names === null || names.some((name) => /^Node(?:Http|ClusterHttp)/.test(name))
            : platformModule?.startsWith("NodeHttp") ||
              platformModule?.startsWith("NodeClusterHttp")

        const mcp =
          effectModule === "ai/index" &&
          (names === null || names.some((name) => mcpTransport.has(name)))

        const nativeHttp = ["http", "https", "http2"].includes(
          (resolved.builtin?.resolved ?? specifier).replace(/^node:/, ""),
        )

        const rpcContract =
          rpcContracts.has(effectModule?.slice(4) ?? "") || contractImport(node, rpcContracts)

        const httpContract =
          httpContracts.has(effectModule?.slice(5) ?? "") || contractImport(node, httpContracts)

        const githubClient =
          backendFile === "github/GitHubClient.ts" &&
          http &&
          (httpClient.has(effectModule?.slice(5) ?? "") || contractImport(node, httpClient))

        const externalTransport =
          !onlyTypes &&
          ((rpc && !rpcContract) ||
            (http && !httpContract && !githubClient) ||
            platformHttp ||
            mcp ||
            nativeHttp)

        if (localTransport || externalTransport) messageId = "transport"
      }

      if (messageId) context.report({ node, messageId, data: { target } })
    }

    function declaration(node: ImportNode) {
      if (node.source) check(node, node.source.value, typeOnly(node))
    }

    return {
      ImportDeclaration: declaration,
      ExportNamedDeclaration: declaration,
      ExportAllDeclaration: declaration,
      ImportExpression(node) {
        const specifier = literalString(node.source)

        if (specifier) check(node, specifier)
      },
      TSImportType(node) {
        check(node, node.source.value, true)
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === "TSExternalModuleReference")
          check(node, node.moduleReference.expression.value, node.importKind === "type")
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          importedPath(context.sourceCode, node.callee) === "global.require"
        ) {
          const specifier = node.arguments[0] && literalString(node.arguments[0])

          if (specifier) check(node, specifier)
        }
      },
    }
  },
})
