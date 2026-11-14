import {
  type CodeToTokensWithThemesOptions,
  createHighlighterCore,
  type GrammarState,
  type LanguageInput,
} from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

const languages = new Map<string, LanguageInput>([
  ["bash", () => import("shiki/langs/shellscript.mjs")],
  ["css", () => import("shiki/langs/css.mjs")],
  ["diff", () => import("shiki/langs/diff.mjs")],
  ["html", () => import("shiki/langs/html.mjs")],
  ["javascript", () => import("shiki/langs/javascript.mjs")],
  ["json", () => import("shiki/langs/json.mjs")],
  ["jsx", () => import("shiki/langs/jsx.mjs")],
  ["markdown", () => import("shiki/langs/markdown.mjs")],
  ["python", () => import("shiki/langs/python.mjs")],
  ["sql", () => import("shiki/langs/sql.mjs")],
  ["tsx", () => import("shiki/langs/tsx.mjs")],
  ["typescript", () => import("shiki/langs/typescript.mjs")],
  ["yaml", () => import("shiki/langs/yaml.mjs")],
])

const aliases = new Map([
  ["js", "javascript"],
  ["md", "markdown"],
  ["py", "python"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["shellscript", "bash"],
  ["ts", "typescript"],
  ["yml", "yaml"],
  ["zsh", "bash"],
])

let shiki: ReturnType<typeof createHighlighterCore> | undefined

const getShiki = () =>
  (shiki ??= createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }))

export async function loadHighlighter(language: string) {
  const name = language.toLowerCase()
  const lang = aliases.get(name) ?? name
  const grammar = languages.get(lang)

  if (grammar === undefined) {
    return null
  }

  const highlighter = await getShiki()

  if (!highlighter.getLoadedLanguages().includes(lang)) {
    await highlighter.loadLanguage(grammar)
  }

  return {
    highlight(code: string, state?: GrammarState) {
      const options: CodeToTokensWithThemesOptions = {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
      }

      if (state !== undefined) {
        options.grammarState = state
      }

      const tokens = highlighter.codeToTokensWithThemes(code, options)

      return {
        lines: tokens.map((line) =>
          line.map((token, index) => (
            <span
              key={index}
              style={{
                color: `light-dark(${token.variants.light?.color}, ${token.variants.dark?.color})`,
              }}
            >
              {token.content}
            </span>
          )),
        ),
        state: highlighter.getLastGrammarState(tokens),
      }
    },
  }
}
