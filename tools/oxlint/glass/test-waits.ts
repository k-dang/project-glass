import { defineRule, type ESTree } from "vite-plus/lint/plugins"
import { binding, importedPath } from "./imports.ts"
import { isTest, projectPath } from "./paths.ts"

const waitFor =
  /^(?:vitest|vite-plus\/test|@effect\/vitest)\.(?:vi|vitest)\.waitFor$|^global\.(?:vi|vitest)\.waitFor$/

const sleep = /^(?:effect\.Effect|effect\/Effect)\.sleep$|^(?:node:)?timers\/promises\.setTimeout$/

const timer = /^(?:global(?:\.(?:globalThis|window))?|(?:node:)?timers)\.setTimeout$/

function bodyExpression(body: ESTree.Node | null): ESTree.Node | null {
  if (!body) return null

  if (body.type !== "BlockStatement") return body

  if (body.body.length !== 1) return null
  const statement = body.body[0]

  if (statement?.type === "ExpressionStatement") return statement.expression

  if (statement?.type === "ReturnStatement") return statement.argument

  return null
}

// An awaited Promise whose executor only schedules its resolver is a sleep.
function resolvesPromise(node: ESTree.CallExpression, source: Parameters<typeof binding>[0]) {
  let callback = node.arguments[0]

  if (callback?.type === "ArrowFunctionExpression" && callback.params.length === 0) {
    const expression = bodyExpression(callback.body)

    if (expression?.type !== "CallExpression" || expression.arguments.length !== 0) return false
    callback = expression.callee
  }

  if (callback?.type !== "Identifier") return false
  const variable = binding(source, callback)

  if (!variable) return false

  return variable.defs.some((definition) => {
    if (definition.type !== "Parameter") return false
    const executor = definition.node

    if (executor.type !== "ArrowFunctionExpression" && executor.type !== "FunctionExpression")
      return false
    const promise = executor.parent

    return (
      executor.params[0] === definition.name &&
      promise.type === "NewExpression" &&
      (promise.parent.type === "AwaitExpression" || promise.parent.type === "YieldExpression") &&
      bodyExpression(executor.body) === node &&
      promise.callee.type === "Identifier" &&
      promise.callee.name === "Promise" &&
      importedPath(source, promise.callee) === "global.Promise"
    )
  })
}

export const testWaits = defineRule({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      wait: "Use eventually from {{helper}} instead of direct vi.waitFor (the default stops after 1s).",
      sleep:
        "Wait for an observable event or use eventually from {{helper}} instead of a sequencing sleep. For deadlines, fork the work and advance TestClock after it is stuck.",
    },
  },
  create(context) {
    const filename = projectPath(context.filename)

    if (!isTest(filename)) return {}

    const helper = filename.startsWith("apps/desktop/")
      ? "apps/desktop/test/eventually.ts"
      : "apps/server/test/eventually.ts"

    if (
      filename === "apps/desktop/test/eventually.ts" ||
      filename === "apps/server/test/eventually.ts"
    )
      return {}

    return {
      CallExpression(node) {
        const path = importedPath(context.sourceCode, node.callee)

        if (!path) return

        if (waitFor.test(path)) {
          context.report({ node, messageId: "wait", data: { helper } })
        } else if (
          (sleep.test(path) &&
            (node.parent.type === "AwaitExpression" || node.parent.type === "YieldExpression")) ||
          (timer.test(path) && resolvesPromise(node, context.sourceCode))
        ) {
          context.report({ node, messageId: "sleep", data: { helper } })
        }
      },
    }
  },
})
