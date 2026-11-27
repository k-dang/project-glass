import { type Duration, Effect, Latch, type Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isolatedGitEnv } from "../src/gitEnv.ts"
import type { FakeCommit, PublishCommits } from "./fakePullRequest.ts"
import { fastImportData } from "./gitRepositories.ts"

const gitEnv = isolatedGitEnv()

const git = (directory: string, args: ReadonlyArray<string>, input?: Buffer) =>
  execFileSync("git", ["-C", directory, ...args], { env: gitEnv, input, encoding: "utf8" }).trim()

const IDENTITY = "Glass Fake <fake@glass.test> 0 +0000"

const MESSAGE = "Fake commit"

const objectId = (type: string, body: Buffer) =>
  createHash("sha1").update(`${type} ${body.byteLength}\0`).update(body).digest()

interface Tree extends Map<string, string | Tree> {}

const treeId = (tree: Tree): Buffer => {
  const entries = Array.from(tree, ([name, entry]) =>
    entry instanceof Map
      ? { sortKey: Buffer.from(`${name}/`), header: `40000 ${name}\0`, id: treeId(entry) }
      : {
          sortKey: Buffer.from(name),
          header: `100644 ${name}\0`,
          id: objectId("blob", Buffer.from(entry)),
        },
  ).toSorted((a, b) => Buffer.compare(a.sortKey, b.sortKey))

  return objectId(
    "tree",
    Buffer.concat(entries.flatMap(({ header, id }) => [Buffer.from(header), id])),
  )
}

const rootTreeId = (files: FakeCommit["files"]) => {
  const root: Tree = new Map()

  for (const [path, contents] of Object.entries(files)) {
    const slash = path.lastIndexOf("/")
    const name = path.slice(slash + 1)
    let tree = root

    for (const part of slash < 0 ? [] : path.slice(0, slash).split("/")) {
      const child = tree.get(part)
      const next: Tree = child instanceof Map ? child : new Map()
      tree.set(part, next)
      tree = next
    }

    tree.set(name, contents)
  }

  return treeId(root).toString("hex")
}

// WARNING: sha must hash what fast-import writes from stream: author defaults to committer, and parent is the ref's previous commit in the stream, since fast-import can't resolve an unwritten `from <sha>`.
const fakeCommit = (ref: string, files: FakeCommit["files"], parent?: string) => ({
  stream: [
    parent === undefined ? `reset ${ref}\n` : "",
    `commit ${ref}\n`,
    `committer ${IDENTITY}\n`,
    fastImportData(MESSAGE),
    "deleteall\n",
    ...Object.entries(files).map(
      ([path, contents]) => `M 100644 inline ${path}\n${fastImportData(contents)}`,
    ),
  ].join(""),
  sha: objectId(
    "commit",
    Buffer.from(
      [
        `tree ${rootTreeId(files)}\n`,
        parent === undefined ? "" : `parent ${parent}\n`,
        `author ${IDENTITY}\n`,
        `committer ${IDENTITY}\n`,
        `\n${MESSAGE}`,
      ].join(""),
    ),
  ).toString("hex"),
})

export interface TrafficMeter {
  readonly around: <A, E, R>(request: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly slow: (delay: Duration.Input) => void
  readonly gather: (count: number) => void
  readonly inFlight: number
  readonly mostAtOnce: number
}

export const trafficMeter = (): TrafficMeter => {
  let delay: Duration.Input = 0
  let gathering: { readonly count: number; readonly together: Latch.Latch } | null = null
  let inFlight = 0
  let mostAtOnce = 0

  return {
    around: (request) =>
      Effect.suspend(() => {
        mostAtOnce = Math.max(mostAtOnce, ++inFlight)

        if (gathering !== null && inFlight >= gathering.count) gathering.together.openUnsafe()
        const hold = gathering === null ? Effect.sleep(delay) : gathering.together.await

        return hold.pipe(
          Effect.andThen(request),
          Effect.ensuring(
            Effect.sync(() => {
              inFlight--
            }),
          ),
        )
      }),
    slow: (next) => {
      delay = next
      gathering = null
      mostAtOnce = 0
    },
    gather: (count) => {
      gathering = { count, together: Latch.makeUnsafe() }
      mostAtOnce = 0
    },
    get inFlight() {
      return inFlight
    },
    get mostAtOnce() {
      return mostAtOnce
    },
  }
}

const httpBackend = (
  root: string,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  body: Uint8Array,
) =>
  Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
    const backend = spawn("git", ["-c", "uploadpack.allowFilter=true", "http-backend"], {
      env: {
        ...gitEnv,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname.slice("/git".length),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.byteLength),
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
      },
    })

    const output: Array<Buffer> = []
    backend.stdout.on("data", (chunk: Buffer) => output.push(chunk))
    backend.on("error", (error) => resume(Effect.die(error)))
    backend.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") resume(Effect.die(error))
    })

    backend.on("close", () => {
      const response = Buffer.concat(output)
      const end = response.indexOf("\r\n\r\n")
      const headers: Record<string, string> = {}

      for (const line of response.subarray(0, end).toString().split("\r\n")) {
        const colon = line.indexOf(":")
        headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
      }

      const { status = "200", ...rest } = headers

      resume(
        Effect.succeed(
          HttpServerResponse.uint8Array(response.subarray(end + 4), {
            status: Number.parseInt(status, 10),
            headers: rest,
          }),
        ),
      )
    })

    backend.stdin.end(body)

    return Effect.callback<void>((closed) => {
      backend.once("close", () => closed(Effect.void))
    })
  })

interface FakeGitRemote {
  readonly publish: PublishCommits
  readonly route: Layer.Layer<never, never, HttpRouter.HttpRouter>
}

export const startFakeGitRemote = Effect.fnUntraced(function* (options: {
  readonly traffic: TrafficMeter
  readonly unavailableRepositories: ReadonlySet<string>
  readonly timingOutRepositories: ReadonlySet<string>
  readonly gitRefusedRepositories: ReadonlySet<string>
}) {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "glass-git-remote-"))),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  )

  const unimported = new Map<string, string>()

  const importPublished = (repository: string) => {
    const stream = unimported.get(repository)

    if (stream === undefined) return
    const directory = join(root, `${repository}.git`)

    if (!existsSync(directory)) git(root, ["init", "--bare", "--quiet", directory])

    git(directory, ["fast-import", "--quiet", "--force"], Buffer.from(stream))
    unimported.delete(repository)
  }

  const publish: PublishCommits = ({ owner, repo, number, base, head }) => {
    const repository = `${owner}/${repo}`.toLowerCase()
    const ref = `refs/pull/${number}/head`
    const baseCommit = fakeCommit(ref, base.files)
    const headCommit = fakeCommit(ref, head.files, baseCommit.sha)

    unimported.set(
      repository,
      (unimported.get(repository) ?? "") + baseCommit.stream + headCommit.stream,
    )

    return {
      base: { ...base, sha: baseCommit.sha },
      head: { ...head, sha: headCommit.sha },
    }
  }

  const serve = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://fake")
    const [owner = "", repo = ""] = url.pathname.slice("/git/".length).split("/")
    const repository = `${owner}/${repo.replace(/\.git$/, "")}`

    if (options.unavailableRepositories.has(repository)) {
      return HttpServerResponse.text("Repository not found.", { status: 404 })
    }

    if (options.gitRefusedRepositories.has(repository)) {
      return HttpServerResponse.text("Permission denied.", { status: 403 })
    }

    yield* Effect.sync(() => importPublished(repository.toLowerCase()))

    return yield* options.traffic.around(
      Effect.gen(function* () {
        if (options.timingOutRepositories.has(repository)) return yield* Effect.never

        const body = new Uint8Array(yield* Effect.orDie(request.arrayBuffer))

        return yield* httpBackend(root, request, url, body)
      }),
    )
  })

  return { publish, route: HttpRouter.add("*", "/git/*", serve) } satisfies FakeGitRemote
})
