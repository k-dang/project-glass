import { VIEWER } from "../../server/test/fakePullRequest"
import { expect, test } from "./glass"

test("keeps the window from scrolling when the Inbox list is taller than it", async ({
  app,
  github,
  window,
}) => {
  for (let number = 1; number <= 8; number++) {
    github
      .seedPullRequest({
        title: `Change ${number}`,
        author: VIEWER.login,
        base: { sha: "b0", files: {} },
        head: { sha: "h1", files: {} },
      })
      .addReview({ author: "monalisa", state: "CHANGES_REQUESTED", bodyHtml: "" })
  }

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 480))

  await window.getByRole("link", { name: "Settings" }).click()
  await window
    .getByRole("textbox", { name: "Repository", exact: true })
    .fill("octo-org/hello-world")
  await window.getByRole("button", { name: "Follow" }).click()
  await window.getByRole("link", { name: "Inbox" }).click()
  const mine = window.getByRole("region", { name: "Your pull requests" })
  await expect(mine.getByRole("button", { name: /Change 8/ })).toBeAttached()

  const list = mine.locator("xpath=..")
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(
    await window.locator("html").evaluate((page) => page.scrollHeight - page.clientHeight),
  ).toBe(0)
})
