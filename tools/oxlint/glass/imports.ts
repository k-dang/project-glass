import type { ESTree, SourceCode, Variable } from "vite-plus/lint/plugins"

export function binding(source: SourceCode, node: ESTree.Node): Variable | null {
  if (node.type !== "Identifier") return null
  let scope = source.getScope(node)

  while (scope) {
    const variable = scope.set.get(node.name)

    if (variable) return variable

    if (!scope.upper) break
    scope = scope.upper
  }

  return null
}

export function literalString(node: ESTree.Node): string | null {
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The parser's Literal union uses value's primitive type as its discriminator.
  return node.type === "Literal" && typeof node.value === "string" ? node.value : null
}

export function propertyName(
  node: ESTree.MemberExpression | ESTree.BindingProperty,
): string | null {
  const key = node.type === "Property" ? node.key : node.property

  if (!node.computed && key.type === "Identifier") return key.name

  return literalString(key)
}

export function importedPath(
  source: SourceCode,
  node: ESTree.Node,
  seen = new Set<Variable>(),
): string | null {
  if (node.type === "MemberExpression") {
    const object = importedPath(source, node.object, seen)
    const property = propertyName(node)

    return object && property ? `${object}.${property}` : null
  }

  if (node.type !== "Identifier") return null
  const variable = binding(source, node)

  if (!variable || variable.defs.length === 0) return `global.${node.name}`

  if (seen.has(variable)) return null
  seen.add(variable)

  for (const definition of variable.defs) {
    const declaration = definition.node

    if (definition.type === "ImportBinding" && definition.parent?.type === "ImportDeclaration") {
      const module = definition.parent.source.value

      if (declaration.type === "ImportNamespaceSpecifier") return module

      if (declaration.type === "ImportSpecifier") {
        const name = declaration.imported

        return `${module}.${name.type === "Identifier" ? name.name : name.value}`
      }

      if (declaration.type === "ImportDefaultSpecifier") return module
    }

    if (
      declaration.type !== "VariableDeclarator" ||
      !declaration.init ||
      definition.parent?.type !== "VariableDeclaration" ||
      definition.parent.kind !== "const" ||
      variable.references.some((reference) => reference.isWrite() && !reference.init)
    )
      continue
    const origin = importedPath(source, declaration.init, seen)

    if (declaration.id.type === "Identifier") return origin

    if (declaration.id.type !== "ObjectPattern") continue

    for (const property of declaration.id.properties) {
      if (
        property.type === "Property" &&
        property.value.type === "Identifier" &&
        property.value.name === node.name
      ) {
        const key = propertyName(property)

        return origin && key ? `${origin}.${key}` : null
      }
    }
  }

  return null
}
