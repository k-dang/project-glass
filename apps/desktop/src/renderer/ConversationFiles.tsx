import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type ConversationFile, MAX_FOUND_FILES, type Turn } from "@glass/contracts"
import { HTML_PAGE_SANDBOX } from "@glass/contracts/desktop"
import { Data, Effect, Match, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
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

const conversationFileAtom = Atom.family((key: FileKey) =>
  backendRuntime.atom(Backend.use((backend) => backend.GetConversationFile(key))),
)

class FileKey extends Data.Class<{ readonly conversationId: string; readonly path: string }> {}

const pathOf = (code: string) => code.trim().replace(/^\.\//, "")

const looksLikePath = (text: string) =>
  text.length <= 260 && /[./]/.test(text) && !/\s|:\/\//.test(text) && !text.startsWith("-")

interface MarkdownNode {
  readonly type: string
  readonly value?: string
  readonly children?: ReadonlyArray<MarkdownNode>
}

const inlineCodeIn = (node: MarkdownNode): ReadonlyArray<string> =>
  node.type === "inlineCode" ? [node.value ?? ""] : (node.children ?? []).flatMap(inlineCodeIn)

const turnPaths = new WeakMap<Turn, ReadonlyArray<string>>()

const pathsOfTurn = (turn: Turn) => {
  const known = turnPaths.get(turn)

  if (known !== undefined) return known

  const paths = turn.parts.flatMap((part) =>
    Predicate.isTagged(part, "Text")
      ? inlineCodeIn(fromMarkdown(part.text)).map(pathOf).filter(looksLikePath)
      : [],
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
  readonly conversationId: string
  readonly paths: ReadonlyArray<string>
}> {}

const foundFilesAtom = Atom.family(({ conversationId, paths }: NamedPathsKey) =>
  backendRuntime.atom(
    paths.length === 0
      ? Effect.succeed(noFiles)
      : Backend.use((backend) => backend.FindConversationFiles({ conversationId, paths })),
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

/** Which inline code in the transcript names a file in the Conversation's folder, gitignored or not. */
export function useFileLinks(
  conversationId: string,
  turns: ReadonlyArray<Turn>,
  loaded: boolean,
  open: (path: string) => void,
) {
  const named = useMemo(() => namedPaths(turns), [turns])
  const atom = foundFilesAtom(new NamedPathsKey({ conversationId, paths: named }))
  const result = AsyncResult.value(useAtomValue(atom))
  const [lastFoundFiles, setLastFoundFiles] = useState(noFiles)

  if (Option.isSome(result) && result.value !== lastFoundFiles) setLastFoundFiles(result.value)

  useRereadWhenTurnEnds(atom, loaded ? lastEndedOf(turns) : undefined)

  return useMemo(() => ({ files: new Set(lastFoundFiles), open }), [lastFoundFiles, open])
}

/** Lets inline code in a Conversation's transcript open a file in its folder. */
export const FileLinks = createContext<{
  readonly files: ReadonlySet<string>
  readonly open: (path: string) => void
} | null>(null)

export function FileLink(props: { text: string; children: ReactNode }) {
  const links = useContext(FileLinks)
  const path = pathOf(props.text)

  if (links === null || !links.files.has(path)) return props.children

  return (
    <button
      type="button"
      title={`Open ${path}`}
      className="cursor-pointer underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
      onClick={() => links.open(path)}
    >
      {props.children}
    </button>
  )
}

const paneWidthAtom = Atom.make(640).pipe(Atom.keepAlive)

export const FilePane = memo(function FilePane(props: {
  conversationId: string
  path: string
  lastEnded: string | null
  onClose: () => void
}) {
  const atom = conversationFileAtom(
    new FileKey({ conversationId: props.conversationId, path: props.path }),
  )

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

function FileView(props: { path: string; file: ConversationFile }) {
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
          Match.when(Match.is("html", "htm"), () => <HtmlDocument path={path} html={text.text} />),
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

function HtmlDocument(props: { path: string; html: string }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    const opened = window.glass.htmlPages.open(props.html)

    void opened.then(setSrc)

    return () => {
      setSrc(null)
      void opened.then(window.glass.htmlPages.close)
    }
  }, [props.html])

  return (
    src !== null && (
      <iframe
        title={props.path}
        src={src}
        sandbox={HTML_PAGE_SANDBOX}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    )
  )
}
