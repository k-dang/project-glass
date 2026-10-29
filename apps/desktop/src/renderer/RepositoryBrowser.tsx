import { TooltipHint } from "@/components/ui/tooltip"
import type { ChangedFile, FileContents, PullRequestRef, Revision } from "@glass/contracts"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { CodeView } from "@pierre/diffs/react"
import { FileTree, useFileTree } from "@pierre/trees/react"
import { cn } from "cn"
import { Match } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { type ReactNode, useLayoutEffect, useMemo, useState } from "react"
import { Backend, backendRuntime } from "./backend"
import { CodeCardHeader, codeCardClassName, codeCardOptions } from "./codeCard"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"
import { shortSha } from "./shortSha"

const repositoryFilesAtom = Atom.family(
  (key: { readonly pullRequest: PullRequestRef; readonly revision: Revision }) =>
    backendRuntime.atom(Backend.use((backend) => backend.ListRepositoryFiles(key))),
)

const fileContentsAtom = Atom.family(
  (key: {
    readonly pullRequest: PullRequestRef
    readonly revision: Revision
    readonly path: string
  }) =>
    backendRuntime
      .atom(Backend.use((backend) => backend.GetFileContents({ ...key, side: "head" })))
      .pipe(Atom.setIdleTTL("5 minutes")),
)

export function RepositoryBrowser(props: {
  pullRequest: PullRequestRef
  revision: Revision
  changedFiles: ReadonlyArray<ChangedFile>
  path: string | null
  onSelect: (path: string) => void
}) {
  const { pullRequest, revision, path, onSelect } = props

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-80 shrink-0 flex-col border-r">
        <RepositoryFilesList
          pullRequest={pullRequest}
          revision={revision}
          changedFiles={props.changedFiles}
          path={path}
          onSelect={onSelect}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {path === null ? (
          <Note>Choose a file to read it at the head, {shortSha(revision.head)}.</Note>
        ) : (
          <FileViewer key={path} pullRequest={pullRequest} revision={revision} path={path} />
        )}
      </div>
    </div>
  )
}

function RepositoryFilesList(props: {
  pullRequest: PullRequestRef
  revision: Revision
  changedFiles: ReadonlyArray<ChangedFile>
  path: string | null
  onSelect: (path: string) => void
}) {
  const { pullRequest, revision } = props

  const atom = repositoryFilesAtom({ pullRequest, revision })
  const retry = useAtomRefresh(atom)

  return AsyncResult.builder(useAtomValue(atom))
    .onInitialOrWaiting(() => <Note>Loading files…</Note>)
    .onFailure((cause) => (
      <div className="p-3">
        <ProblemAlert problem={problemOf(cause)} action={{ label: "Try again", run: retry }} />
      </div>
    ))
    .onSuccess((value) => (
      <>
        {value.truncated && (
          <Note>
            The repository is too large for GitHub to list in full; some files are missing.
          </Note>
        )}
        <RepositoryTree
          paths={value.paths}
          changedFiles={props.changedFiles}
          initialPath={props.path}
          onSelect={props.onSelect}
        />
      </>
    ))
    .render()
}

function Note(props: { children: ReactNode }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground">{props.children}</p>
}

/** useFileTree applies its options only when creating the model. */
function RepositoryTree(props: {
  paths: ReadonlyArray<string>
  changedFiles: ReadonlyArray<ChangedFile>
  initialPath: string | null
  onSelect: (path: string) => void
}) {
  const { onSelect } = props
  const [files] = useState(() => new Set(props.paths))
  const [initialPath] = useState(props.initialPath)

  const { model } = useFileTree({
    paths: props.paths,
    initialSelectedPaths: initialPath === null ? [] : [initialPath],
    initialExpandedPaths:
      initialPath === null
        ? []
        : Array.from(initialPath.matchAll(/\//g), ({ index }) => initialPath.slice(0, index + 1)),
    gitStatus: props.changedFiles.flatMap((file) =>
      file.changeType === "deleted" ? [] : [{ path: file.path, status: file.changeType }],
    ),
    flattenEmptyDirectories: true,
    density: "compact",
    search: true,
    onSelectionChange: ([path]) => {
      if (path !== undefined && files.has(path)) onSelect(path)
    },
  })

  useLayoutEffect(() => {
    if (initialPath !== null) model.scrollToPath(initialPath, { focus: false })
  }, [model, initialPath])

  return <FileTree model={model} className="file-tree min-h-0 flex-1 pt-2" />
}

function FileViewer(props: { pullRequest: PullRequestRef; revision: Revision; path: string }) {
  const { pullRequest, revision, path } = props

  const atom = fileContentsAtom({ pullRequest, revision, path })
  const retry = useAtomRefresh(atom)

  return AsyncResult.builder(useAtomValue(atom))
    .onInitialOrWaiting(() => <Note>Loading {path}…</Note>)
    .onFailure((cause) => (
      <div className="p-6">
        <ProblemAlert problem={problemOf(cause)} action={{ label: "Try again", run: retry }} />
      </div>
    ))
    .onSuccess((value) => <FileContentsView path={path} contents={value} />)
    .render()
}

function FileContentsView(props: { path: string; contents: FileContents }) {
  const { path, contents } = props

  return Match.value(contents).pipe(
    Match.tagsExhaustive({
      TextFile: ({ text }) => <FileText path={path} text={text} />,
      BinaryFile: () => <FilePlaceholder path={path} placeholder="Binary file not shown" />,
      FileTooLarge: () => <FilePlaceholder path={path} placeholder="File too large to show" />,
    }),
  )
}

function FilePath(props: { path: string }) {
  return (
    <TooltipHint content={props.path}>
      <span className="min-w-0 flex-1 truncate font-mono">{props.path}</span>
    </TooltipHint>
  )
}

function FilePlaceholder(props: { path: string; placeholder: string }) {
  return (
    <div className="m-6 overflow-clip rounded-lg ring-1 ring-border">
      <CodeCardHeader>
        <FilePath path={props.path} />
        <span className="text-muted-foreground">{props.placeholder}</span>
      </CodeCardHeader>
    </div>
  )
}

function FileText(props: { path: string; text: string }) {
  const { path, text } = props

  const items = useMemo(
    () => [{ type: "file" as const, id: path, file: { name: path, contents: text } }],
    [path, text],
  )

  return (
    <CodeView
      items={items}
      options={codeCardOptions}
      renderCustomHeader={() => (
        <CodeCardHeader>
          <FilePath path={path} />
        </CodeCardHeader>
      )}
      className={cn("min-h-0 flex-1 overflow-auto p-6", codeCardClassName)}
    />
  )
}
