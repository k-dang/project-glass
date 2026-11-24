import {
  type BootstrapOptions,
  VISUALIZATION_THEME_PARAM,
  VISUALIZATION_THEME_VARIABLES,
  visualizationBootstrap,
} from "@glass/contracts"

export const MAX_PAGE_BYTES = 25 * 1024 * 1024

const DOCUMENT_START = /^\s*<(?:!doctype\s+html|html)[\s>]/i

export const isHtmlDocument = (html: string) => DOCUMENT_START.test(html)

const CSS_SOURCE =
  /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi

const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i

export const viewportHeightUnitIn = (html: string) => {
  for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
    const found = VIEWPORT_HEIGHT_UNIT.exec(sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "")

    if (found !== null) return found[0]
  }

  return null
}

const IMAGE_EXTENSIONS = "gif|jpe?g|png|svg|webp"

const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`

const LOCAL_IMAGE = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
)

interface ImageReference {
  readonly start: number
  readonly end: number
  readonly path: string
}

export const localImagesIn = (html: string): ReadonlyArray<ImageReference> =>
  Array.from(html.matchAll(LOCAL_IMAGE)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3]

    return span === undefined ? [] : [{ start: span[0], end: span[1], path: html.slice(...span) }]
  })

export const unescapedFilePath = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference

export const withImages = (
  html: string,
  references: ReadonlyArray<ImageReference>,
  dataUris: ReadonlyMap<string, string>,
) => {
  const parts: Array<string> = []
  let cursor = 0

  for (const { start, end, path } of references) {
    parts.push(html.slice(cursor, start), dataUris.get(path) ?? path)
    cursor = end
  }

  parts.push(html.slice(cursor))

  return parts.join("")
}

const CHART_COLORS = [
  ["#0d9488", "#2dd4bf"],
  ["#d97706", "#fbbf24"],
  ["#9333ea", "#c084fc"],
  ["#e11d48", "#fb7185"],
  ["#65a30d", "#a3e635"],
]

const BASE_CSS =
  `:root{color-scheme:light dark;${CHART_COLORS.map(([light, dark], index) => `--chart-${index + 1}:light-dark(${light},${dark});`).join("")}}` +
  "html{box-sizing:border-box;padding:8px;background:var(--background);color:var(--foreground);font-family:var(--font-ui,system-ui,sans-serif);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;scrollbar-width:none}" +
  "body{margin:0}code,kbd,pre,samp{font-family:var(--font-code,ui-monospace,monospace)}"

const THEME_STYLE_ID = "glass-visualization-theme"

const BOOTSTRAP_SCRIPT = `(${visualizationBootstrap.toString()})(window, ${JSON.stringify({
  styleId: THEME_STYLE_ID,
  baseCss: BASE_CSS,
  themeParam: VISUALIZATION_THEME_PARAM,
  sizedTag: "VisualizationSized",
  linkOpenedTag: "VisualizationLinkOpened",
} satisfies BootstrapOptions)})`

const BOOTSTRAP = `<style id="${THEME_STYLE_ID}">${BASE_CSS}</style><script>${BOOTSTRAP_SCRIPT}</script>`

const NON_MARKUP =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi

const blankNonMarkup = (html: string) =>
  html.replace(NON_MARKUP, (match) => " ".repeat(match.length))

const openTag = (name: string) => new RegExp(`<${name}(?:\\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>`, "i")

const HEAD = openTag("head")

const ROOT = openTag("html")

const DOCTYPE = /^\s*<!doctype[^>]*>/i

const insertedAfter = (html: string, at: number, markup: string) =>
  `${html.slice(0, at)}${markup}${html.slice(at)}`

export const withBootstrap = (html: string) => {
  const scan = blankNonMarkup(html)
  const head = HEAD.exec(scan)

  if (head !== null) return insertedAfter(html, head.index + head[0].length, BOOTSTRAP)

  const root = ROOT.exec(scan) ?? DOCTYPE.exec(scan)

  return root === null
    ? `<!doctype html><head>${BOOTSTRAP}</head>${html}`
    : insertedAfter(html, root.index + root[0].length, `<head>${BOOTSTRAP}</head>`)
}

export const PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts",
].join("; ")

export const PAGE_GUIDE = [
  "The page shows inline in the Thread at the reply's width, on the Thread's background with an 8px gutter.",
  "Leave html and body with no background, border, banner title, or side padding. A box that needs its own background gets 16px padding and var(--radius) corners.",
  "Let content set the height: vh units are refused, and height:100% on html or body loops. Give charts fixed pixel heights.",
  `Use the theme's CSS variables, not fixed colors: ${VISUALIZATION_THEME_VARIABLES.join(", ")}, and --chart-1 to --chart-${CHART_COLORS.length}.`,
  "Inline <style> and <script>. Scripts, styles, and images may load from https, but the page can't make requests. Local images given as absolute paths in the Thread's folder are inlined.",
].join(" ")
