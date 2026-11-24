import { assert, describe, it } from "@effect/vitest"
import {
  SHOW_VISUALIZATION_TOOL,
  TOKEN_PARAM,
  VISUALIZATIONS_PATH,
  VisualizationShown,
} from "@glass/contracts"
import { Effect, Schema } from "effect"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { LAUNCH_TOKEN } from "../../test/harness"
import { connectMcp, toolText } from "../../test/mcpClient"
import { calledBy, glassCall, settled, threadsFixture } from "../../test/threadsFixture"
import { GlobalChatCaller } from "./McpCredentials"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

const decodeShown = Schema.decodeUnknownSync(VisualizationShown)

const pageAt = (baseUrl: string, id: string) =>
  Effect.promise(async () => {
    const response = await fetch(
      `${baseUrl}${VISUALIZATIONS_PATH}/${id}?${TOKEN_PARAM}=${LAUNCH_TOKEN}`,
    )

    return {
      status: response.status,
      policy: response.headers.get("content-security-policy"),
      body: await response.text(),
    }
  })

describe("show_visualization", () => {
  it.live(
    "shows a page from the Thread's folder with its images inlined, and refuses an image it can't read",
    () =>
      Effect.gen(function* () {
        const f = yield* threadsFixture
        const thread = yield* f.start()
        yield* f.transcript(thread.id, settled(1))

        const folder = f.worktree(thread.name)
        const image = join(folder, "shot.png")

        yield* Effect.promise(async () => {
          await writeFile(image, png)
          await writeFile(
            join(folder, "chart.html"),
            `<!doctype html><html><head><title>Chart</title></head><body><img src="${image}"></body></html>`,
          )
        })

        const show = (turn: number, args: Readonly<Record<string, string>>) =>
          f.send(thread.id, glassCall(SHOW_VISUALIZATION_TOOL, { title: "Chart", ...args })).pipe(
            Effect.andThen(f.transcript(thread.id, settled(turn))),
            Effect.map((turns) => calledBy(turns.at(-1))),
          )

        const shown = yield* show(2, { path: join(folder, "chart.html") })
        assert.equal(shown.status, "done", shown.text)

        const page = yield* pageAt(f.baseUrl, decodeShown(JSON.parse(shown.text)).visualization.id)
        assert.equal(page.status, 200)
        assert.include(page.policy, "sandbox allow-scripts")
        assert.include(page.policy, "connect-src 'none'")
        assert.include(page.body, '<style id="glass-visualization-theme">')
        assert.include(page.body, `<img src="data:image/png;base64,${png.toString("base64")}">`)

        const missing = join(folder, "missing.png")

        const unseen = yield* show(3, {
          html: `<!doctype html><img src="${missing}">`,
        })

        assert.equal(unseen.status, "failed")
        assert.include(unseen.text, missing)

        const large = ["a", "b", "c"].map((name) => join(folder, `${name}.png`))

        yield* Effect.promise(() =>
          Promise.all(large.map((path) => writeFile(path, Buffer.alloc(9_000_000)))),
        )

        const oversized = yield* show(4, {
          html: `<!doctype html>${large.map((path) => `<img src="${path}">`).join("")}`,
        })

        assert.equal(oversized.status, "failed")
        assert.include(oversized.text, "over 25 MiB")

        assert.equal((yield* pageAt(f.baseUrl, "no-such-visualization")).status, 404)
      }),
  )

  it.live("shows the Global chat's inline HTML but no files, since it has no folder", () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture
      const caller = GlobalChatCaller.make({ globalChatId: "global-chat", sessionId: "session" })
      const { call } = yield* connectMcp(f.baseUrl, yield* f.mcpCredentials.issue(caller))

      const shown = yield* call(SHOW_VISUALIZATION_TOOL, {
        title: "Table",
        html: "<!doctype html><table><tr><td>1</td></tr></table>",
      })

      assert.isFalse(shown.isError, toolText(shown))

      const { visualization } = decodeShown(shown.structuredContent)

      assert.include((yield* pageAt(f.baseUrl, visualization.id)).body, "<td>1</td>")

      const fromFile = yield* call(SHOW_VISUALIZATION_TOOL, { title: "Table", path: "table.html" })
      assert.isTrue(fromFile.isError)
      assert.include(toolText(fromFile), "Pass html instead")
    }),
  )
})
