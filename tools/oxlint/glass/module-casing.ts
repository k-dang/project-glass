import { defineRule } from "vite-plus/lint/plugins"
import { readdirSync } from "node:fs"
import { basename, dirname } from "node:path"

const source = /\.[cm]?[jt]sx?$/

const stemOf = (name: string) => name.replace(source, "")

const stemsByDirectory = new Map<string, ReadonlyArray<string>>()

const stemsIn = (directory: string) => {
  let stems = stemsByDirectory.get(directory)

  if (stems === undefined) {
    stems = readdirSync(directory)
      .filter((name) => source.test(name))
      .map(stemOf)
    stemsByDirectory.set(directory, stems)
  }

  return stems
}

export const moduleCasing = defineRule({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      casing:
        "{{stem}} and {{other}} differ only in case. On macOS an import of one can load the other; rename one.",
    },
  },
  create(context) {
    const stem = stemOf(basename(context.filename))
    const lower = stem.toLowerCase()

    const other = stemsIn(dirname(context.filename)).find(
      (sibling) => sibling !== stem && sibling.toLowerCase() === lower,
    )

    if (other === undefined) return {}

    return {
      Program(node) {
        context.report({ node, messageId: "casing", data: { stem, other } })
      },
    }
  },
})
