import { assert, it } from "@effect/vitest"
import { THREAD_FILES_PATH, TOKEN_PARAM } from "@glass/contracts"
import { Effect } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { LAUNCH_TOKEN } from "../test/harness"
import { settled, threadsFixture } from "../test/threadsFixture"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

it.live(
  "serves the files in a Thread's folder by path, typed for a browser, and nothing outside it",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const thread = yield* f.start()
      const worktree = f.worktree(thread.name)

      yield* Effect.promise(async () => {
        await mkdir(join(worktree, "docs", "my plan"), { recursive: true })
        await writeFile(join(worktree, "docs", "my plan", "index.html"), "<h1>Plan</h1>")
        await writeFile(join(worktree, "docs", "my plan", "style.css"), "h1 { color: red }")
        await writeFile(join(worktree, "docs", "my plan", "shot.png"), png)
      })

      const get = (path: string) =>
        Effect.promise(async () => {
          const response = await fetch(
            `${f.baseUrl}${THREAD_FILES_PATH}/local/${thread.id}/${path}?${TOKEN_PARAM}=${LAUNCH_TOKEN}`,
          )

          return {
            status: response.status,
            type: response.headers.get("content-type"),
            body: Buffer.from(await response.arrayBuffer()),
          }
        })

      const page = yield* get("docs/my%20plan/index.html")
      assert.deepStrictEqual(
        { ...page, body: page.body.toString() },
        { status: 200, type: "text/html; charset=utf-8", body: "<h1>Plan</h1>" },
      )

      const style = yield* get("docs/my%20plan/style.css")
      assert.equal(style.type, "text/css; charset=utf-8")

      const image = yield* get("docs/my%20plan/shot.png")
      assert.deepStrictEqual(image, { status: 200, type: "image/png", body: png })

      assert.equal((yield* get("..%2F..%2Fsecrets.txt")).status, 404)
      assert.equal((yield* get("docs/missing.html")).status, 404)
    }),
)

it.live("serves a Thread's files only to Browser panes of the place it runs in", () =>
  Effect.gen(function* () {
    const f = yield* threadsFixture
    const local = yield* f.start()
    const sandboxed = yield* f.startSandbox()
    yield* f.transcript(local.id, settled(1))
    yield* f.transcript(sandboxed.id, settled(1))

    const status = (place: string, threadId: string) =>
      Effect.promise(async () => {
        const response = await fetch(
          `${f.baseUrl}${THREAD_FILES_PATH}/${place}/${threadId}/README.md?${TOKEN_PARAM}=${LAUNCH_TOKEN}`,
        )

        return response.status
      })

    assert.deepStrictEqual(
      [
        yield* status("local", local.id),
        yield* status("sandbox", local.id),
        yield* status("sandbox", sandboxed.id),
        yield* status("local", sandboxed.id),
      ],
      [200, 404, 200, 404],
    )
  }),
)
