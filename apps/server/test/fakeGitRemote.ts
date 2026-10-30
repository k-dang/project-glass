import { type Duration, Effect, Latch, type Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isolatedGitEnv } from "../src/gitEnv.ts"
import type { FakeCommit, PublishCommits } from "./fakePullRequest.ts"

const gitEnv = isolatedGitEnv()

const git = (directory: string, args: ReadonlyArray<string>, input?: Buffer) =>
  execFileSync("git", ["-C", directory, ...args], { env: gitEnv, input, encoding: "utf8" }).trim()

const data = (text: string) => [`data ${Buffer.byteLength(text)}\n`, text, "\n"]

// Fixed metadata makes a commit's SHA depend only on its files and parent, so publishing again keeps it.
const fastImportCommit = (ref: string, files: FakeCommit["files"]) => [
  `commit ${ref}\n`,
  "committer Glass Fake <fake@glass.test> 0 +0000\n",
  ...data("Fake commit"),
  "deleteall\n",
  ...Object.entries(files).flatMap(([path, contents]) => [
    `M 100644 inline ${path}\n`,
    ...data(contents),
  ]),
]

export interface TrafficMeter {
  readonly around: <A, E, R>(request: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly slow: (delay: Duration.Input) => void
  readonly gather: (count: number) => void
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
    get mostAtOnce() {
      return mostAtOnce
    },
  }
}

/** Runs `git http-backend`, the CGI program behind git's smart HTTP, for one request. */
const httpBackend = (
  root: string,
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  body: Uint8Array,
) =>
  Effect.callback<HttpServerResponse.HttpServerResponse>((resume) => {
    const backend = spawn("git", ["http-backend"], {
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
  })

export interface FakeGitRemote {
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

  const repositoryDirectory = (owner: string, repo: string) => {
    const directory = join(root, owner, `${repo}.git`)

    if (!existsSync(directory)) {
      git(root, ["init", "--bare", "--quiet", directory])
      git(directory, ["config", "uploadpack.allowFilter", "true"])
    }

    return directory
  }

  const publish: PublishCommits = ({ owner, repo, number, base, head }) => {
    const directory = repositoryDirectory(owner, repo)
    const ref = `refs/pull/${number}/head`

    const stream = [
      `reset ${ref}\n`,
      ...fastImportCommit(ref, base.files),
      ...fastImportCommit(ref, head.files),
    ]

    git(directory, ["fast-import", "--quiet", "--force"], Buffer.from(stream.join("")))
    const [headSha = "", baseSha = ""] = git(directory, ["rev-parse", ref, `${ref}^`]).split("\n")

    return { base: { ...base, sha: baseSha }, head: { ...head, sha: headSha } }
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
