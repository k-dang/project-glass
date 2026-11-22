import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type ThreadFile, MAX_FOUND_FILES, type Turn } from "@glass/contracts"
import { Data, Effect, Match, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import type { Image, Link, Nodes, Root } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
import {
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { AgentReviewMarkdown } from "./AgentReviewPanel"
import { Backend, backendRuntime } from "./backend"
import { fileName } from "./fileName"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"
import { imageSrc } from "./pastedImages"
import { FileContentsView } from "./RepositoryBrowser"
import { SidePanel } from "./SidePanel"

const threadFileAtom = Atom.family((key: FileKey) =>
  backendRuntime.atom(Backend.use((backend) => backend.GetThreadFile(key))),
)

class FileKey extends Data.Class<{ readonly threadId: string; readonly path: string }> {}

const pathOf = (code: string) => code.trim().replace(/^\.\//, "")

const looksLikePath = (text: string) =>
  text.length <= 260 && /[./]/.test(text) && !/\s|:\/\//.test(text) && !text.startsWith("-")

const childrenOf = (node: Nodes): ReadonlyArray<Nodes> => ("children" in node ? node.children : [])

const inlineCodeIn = (node: Nodes): ReadonlyArray<string> =>
  node.type === "inlineCode" ? [node.value] : childrenOf(node).flatMap(inlineCodeIn)

const LOCAL_FILE = "/glass-file/"

const windowsPath = /^[a-z]:[\\/]/i

const destination = /\]\(\s*(?:<([^>]*)>|(\S+?))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/

// WARNING: Markdown reads `\.` in `C:\Users\me\.config` as an escaped dot, so take the destination as written.
const writtenUrl = (node: Link | Image, source: string) => {
  const start = node.position?.start.offset
  const end = node.position?.end.offset

  const written =
    start === undefined || end === undefined ? null : destination.exec(source.slice(start, end))

  const raw = written?.[1] ?? written?.[2]

  return raw !== undefined &&
    /^[a-z]:\\/i.test(raw) &&
    raw.replace(/\\([!-/:-@[-`{-~])/g, "$1") === node.url
    ? raw
    : node.url
}

const decoded = (text: string) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

const localPathOf = (url: string) => {
  const written = url.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "")
  const path = decoded(written) ?? written
  const hasScheme = /^[a-z][\w+.-]*:/i.test(path) && !windowsPath.test(path)

  return path === "" || hasScheme || path.startsWith("//") ? null : pathOf(path)
}

const forEachLocalFile = (
  node: Nodes,
  source: string,
  found: (node: Link | Image, path: string) => void,
) => {
  if (node.type === "link" || node.type === "image") {
    const path = localPathOf(writtenUrl(node, source))

    if (path !== null) found(node, path)
  }

  for (const child of childrenOf(node)) forEachLocalFile(child, source, found)
}

export const remarkLocalFiles = () => (tree: Root, file: { readonly value: unknown }) =>
  forEachLocalFile(tree, String(file.value), (node, path) => {
    node.url = LOCAL_FILE + encodeURIComponent(path)
  })

export const localFilePath = (url: string | Blob | undefined) =>
  Predicate.isString(url) && url.startsWith(LOCAL_FILE)
    ? decoded(url.slice(LOCAL_FILE.length))
    : null

const readBeforeTurnEnds = (node: Link | Image) => node.type === "image"

const pathsIn = (text: string) => {
  const tree = fromMarkdown(text)
  const paths = inlineCodeIn(tree).map(pathOf).filter(looksLikePath)

  forEachLocalFile(tree, text, (node, path) => {
    if (!readBeforeTurnEnds(node)) paths.push(path)
  })

  return paths
}

const turnPaths = new WeakMap<Turn, ReadonlyArray<string>>()

const pathsOfTurn = (turn: Turn) => {
  const known = turnPaths.get(turn)

  if (known !== undefined) return known

  const paths = turn.parts.flatMap((part) =>
    Predicate.isTagged(part, "Text") ? pathsIn(part.text) : [],
  )

  turnPaths.set(turn, paths)

  return paths
}

const namedPaths = (turns: ReadonlyArray<Turn>) => {
  const named = new Set<string>()

  for (const turn of turns)
    if (turn.ended !== null)
      for (const path of pathsOfTurn(turn)) {
        named.delete(path)
        named.add(path)
      }

  return [...named].slice(-MAX_FOUND_FILES).toSorted()
}

class NamedPathsKey extends Data.Class<{
  readonly threadId: string
  readonly paths: ReadonlyArray<string>
}> {}

const foundFilesAtom = Atom.family(({ threadId, paths }: NamedPathsKey) =>
  backendRuntime.atom(
    paths.length === 0
      ? Effect.succeed(noFiles)
      : Backend.use((backend) => backend.FindThreadFiles({ threadId, paths })),
  ),
)

const noFiles: ReadonlyArray<string> = []

export const lastEndedOf = (turns: ReadonlyArray<Turn>) =>
  turns.findLast((turn) => turn.ended !== null)?.id ?? null

function useRereadWhenTurnEnds(atom: Atom.Atom<unknown>, lastEnded: string | null | undefined) {
  const refresh = useAtomRefresh(atom)
  const seen = useRef({ atom, lastEnded })

  useEffect(() => {
    const before = seen.current
    seen.current = { atom, lastEnded }

    if (before.atom === atom && before.lastEnded !== undefined && before.lastEnded !== lastEnded)
      refresh()
  }, [atom, lastEnded, refresh])
}

export function useFileLinks(
  threadId: string,
  turns: ReadonlyArray<Turn>,
  loaded: boolean,
  open: (path: string) => void,
) {
  const named = useMemo(() => namedPaths(turns), [turns])
  const atom = foundFilesAtom(new NamedPathsKey({ threadId, paths: named }))
  const result = AsyncResult.value(useAtomValue(atom))
  const [lastFoundFiles, setLastFoundFiles] = useState(noFiles)

  if (Option.isSome(result) && result.value !== lastFoundFiles) setLastFoundFiles(result.value)

  const lastEnded = loaded ? lastEndedOf(turns) : undefined

  useRereadWhenTurnEnds(atom, lastEnded)

  return useMemo(
    (): FileLinksValue => ({ threadId, files: new Set(lastFoundFiles), lastEnded, open }),
    [threadId, lastFoundFiles, lastEnded, open],
  )
}

interface FileLinksValue {
  readonly threadId: string
  readonly files: ReadonlySet<string>
  readonly lastEnded: string | null | undefined
  readonly open: (path: string) => void
}

export const FileLinks = createContext<FileLinksValue | null>(null)

export function FileImage(props: { path: string; alt: string | undefined }) {
  const links = useContext(FileLinks)
  const alt = props.alt || fileName(props.path)

  return links === null ? (
    <ImageAlt text={alt} />
  ) : (
    <LoadedImage links={links} path={props.path} alt={alt} />
  )
}

function ImageAlt(props: { text: string }) {
  return <span className="text-muted-foreground">{props.text}</span>
}

function LoadedImage(props: { links: FileLinksValue; path: string; alt: string }) {
  const { links, path } = props
  const insideLink = useContext(InsideFileLink)
  const atom = threadFileAtom(new FileKey({ threadId: links.threadId, path }))
  const result = useAtomValue(atom)
  const file = AsyncResult.isFailure(result) ? null : Option.getOrNull(AsyncResult.value(result))

  useRereadWhenTurnEnds(atom, links.lastEnded)

  if (file?._tag !== "ImageFile") return <ImageAlt text={props.alt} />

  const image = (
    <img
      src={imageSrc(file.mediaType, file.data)}
      alt={props.alt}
      className="max-h-96 max-w-full rounded-md border"
    />
  )

  return insideLink ? (
    image
  ) : (
    <button
      type="button"
      title={`Open ${path}`}
      className="block cursor-pointer"
      onClick={() => links.open(path)}
    >
      {image}
    </button>
  )
}

const InsideFileLink = createContext(false)

export function FileLink(props: { text: string; children: ReactNode }) {
  const links = useContext(FileLinks)
  const insideLink = useContext(InsideFileLink)
  const path = pathOf(props.text)

  if (links === null || insideLink || !links.files.has(path)) return props.children

  return (
    <button
      type="button"
      title={`Open ${path}`}
      className="cursor-pointer underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
      onClick={() => links.open(path)}
    >
      <InsideFileLink value>{props.children}</InsideFileLink>
    </button>
  )
}

const paneWidthAtom = Atom.make(640).pipe(Atom.keepAlive)

export const FilePane = memo(function FilePane(props: {
  threadId: string
  path: string
  lastEnded: string | null
  onClose: () => void
}) {
  const atom = threadFileAtom(new FileKey({ threadId: props.threadId, path: props.path }))

  const retry = useAtomRefresh(atom)

  useRereadWhenTurnEnds(atom, props.lastEnded)

  return (
    <SidePanel
      name="File"
      heading={fileName(props.path)}
      width={paneWidthAtom}
      onClose={props.onClose}
    >
      {AsyncResult.builder(useAtomValue(atom))
        .onInitial(() => <p className="p-5 text-sm text-muted-foreground">Loading…</p>)
        .onFailure((cause) => (
          <div className="p-5">
            <ProblemAlert problem={problemOf(cause)} action={{ label: "Try again", run: retry }} />
          </div>
        ))
        .onSuccess((file) => <FileView path={props.path} file={file} />)
        .render()}
    </SidePanel>
  )
})

const extension = (path: string) => /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""

export const isHtmlFile = (path: string) => ["html", "htm"].includes(extension(path))

function FileView(props: { path: string; file: ThreadFile }) {
  const { path, file } = props

  return Match.value(file).pipe(
    Match.tagsExhaustive({
      ImageFile: ({ mediaType, data }) => (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <img src={imageSrc(mediaType, data)} alt={fileName(path)} className="max-w-full" />
        </div>
      ),
      TextFile: (text) =>
        Match.value(extension(path)).pipe(
          Match.when(Match.is("md", "markdown"), () => (
            <AgentReviewMarkdown
              markdown={text.text}
              className="min-h-0 flex-1 overflow-auto p-5"
            />
          )),
          Match.orElse(() => <FileContentsView path={path} contents={text} />),
        ),
      BinaryFile: (binary) => <FileContentsView path={path} contents={binary} />,
      FileTooLarge: (tooLarge) => <FileContentsView path={path} contents={tooLarge} />,
    }),
  )
}
