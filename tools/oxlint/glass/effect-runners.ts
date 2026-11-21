import { defineRule, type ESTree } from "vite-plus/lint/plugins"
import { importedPath, propertyName } from "./imports.ts"
import { isTest, projectPath } from "./paths.ts"

const runner =
  /^(?:effect\.Effect|effect\/Effect)\.(runFork|runPromise|runPromiseExit|runSync|runSyncExit|runCallback)$/

const managedRuntime = /^(?:effect\.ManagedRuntime|effect\/ManagedRuntime)\.make$/

export const effectRunners = defineRule({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      runner:
        "Effect.{{name}} runs with an empty context, so its logs skip backend.log's JSON logger and the unit's trace. Use FiberSet.makeRuntime() or makeRuntimePromise() inside a scope, or Effect.runForkWith(context) with a captured context.",
      managedRuntime:
        "ManagedRuntime.make starts a second runtime outside the server's layer, without its logger or the unit's trace. Provide the service through the server's layer, and bridge callbacks with FiberSet.makeRuntime() or makeRuntimePromise() inside a scope.",
    },
  },
  create(context) {
    const filename = projectPath(context.filename)

    if (!filename.startsWith("apps/server/src/") || isTest(filename)) return {}

    function check(node: ESTree.Node, path: string | null) {
      const name = path?.match(runner)?.[1]

      if (name) context.report({ node, messageId: "runner", data: { name } })
      else if (path && managedRuntime.test(path))
        context.report({ node, messageId: "managedRuntime" })
    }

    return {
      MemberExpression(node) {
        check(node, importedPath(context.sourceCode, node))
      },
      ObjectPattern(node) {
        if (node.parent.type !== "VariableDeclarator" || !node.parent.init) return

        const origin = importedPath(context.sourceCode, node.parent.init)

        if (!origin) return

        for (const property of node.properties) {
          const key = property.type === "Property" ? propertyName(property) : null

          if (key) check(property, `${origin}.${key}`)
        }
      },
      ImportSpecifier(node) {
        if (
          node.parent.type !== "ImportDeclaration" ||
          node.parent.importKind === "type" ||
          node.importKind === "type"
        )
          return

        const imported =
          node.imported.type === "Identifier" ? node.imported.name : node.imported.value

        check(node, `${node.parent.source.value}.${imported}`)
      },
    }
  },
})
