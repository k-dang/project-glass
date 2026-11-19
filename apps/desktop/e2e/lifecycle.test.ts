import { VIEWER } from "../../server/test/fakePullRequest"
import { expect, openPullRequest, test } from "./glass"

test("opens the built renderer signed in to GitHub", async ({ window }) => {
  await expect(window).toHaveURL(/^glass:\/\/app\/index\.html/)
  await expect(
    window.getByRole("status", { name: `@${VIEWER.login} · via GH_TOKEN` }),
  ).toBeVisible()

  await window.getByRole("button", { name: "Show Glass resource usage" }).click()
  const processes = window.getByRole("table", { name: "Resource usage by process" })
  await expect(processes.getByRole("row", { name: /^Backend / })).toBeVisible()
  await window.keyboard.press("Escape")
  await expect(processes).toBeHidden()
})

test("restarts a crashed backend and works again", async ({ app, github, window }) => {
  const pr = github.seedPullRequest({
    base: { sha: "b0", files: {} },
    head: { sha: "h1", files: {} },
  })

  await expect(window.getByRole("status", { name: new RegExp(`^@${VIEWER.login}`) })).toBeVisible()

  const backend = await app.evaluate(({ app: electron }) => {
    const metric = electron.getAppMetrics().find(({ name }) => name === "Glass backend")

    if (metric === undefined) throw new Error("The backend process isn't running")

    return metric.pid
  })

  process.kill(backend, "SIGKILL")

  const reconnecting = window.getByText("Reconnecting to Glass's backend…")
  await expect(reconnecting).toBeVisible()
  await expect(reconnecting).toBeHidden()

  await openPullRequest(window, pr)
})
