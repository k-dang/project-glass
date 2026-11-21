import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type ThreadFile, MAX_FOUND_FILES, type Turn } from "@glass/contracts"
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
import { PageWithNotes } from "./PageNotes"
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

  useRereadWhenTurnEnds(atom, loaded ? lastEndedOf(turns) : undefined)

  return useMemo(() => ({ files: new Set(lastFoundFiles), open }), [lastFoundFiles, open])
}

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
        .onSuccess((file) => <FileView threadId={props.threadId} path={props.path} file={file} />)
        .render()}
    </SidePanel>
  )
})

const extension = (path: string) => /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""

function FileView(props: { threadId: string; path: string; file: ThreadFile }) {
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
          Match.when(Match.is("html", "htm"), () => (
            <PageWithNotes
              key={`${path}
${text.text}`}
              threadId={props.threadId}
              path={path}
              html={text.text}
            />
          )),
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
