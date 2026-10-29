import { assert, describe, it } from "@effect/vitest"
import { ChangedFile, NoTextChanges, PullRequestRef, Revision, TextPatch } from "@glass/contracts"
import { Effect } from "effect"
import { startSignedInBackend } from "../../test/harness"

const base = {
  sha: "b0",
  files: { "README.md": "Hello\n", "old-name.ts": "export {}\n", "gone.txt": "bye\n" },
}

const head = {
  sha: "h1",
  files: { "README.md": "Hello, world\n", "new-name.ts": "export {}\n", "src/greet.ts": "hi\n" },
}

describe("changed files", () => {
  it.live("lists each changed file with its change type, line counts, and patch", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles: [
          {
            path: "README.md",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-Hello\n+Hello, world",
          },
          { path: "src/greet.ts", status: "added", additions: 1, patch: "@@ -0,0 +1 @@\n+hi" },
          { path: "gone.txt", status: "removed", deletions: 1, patch: "@@ -1 +0,0 @@\n-bye" },
          { path: "new-name.ts", status: "renamed", previousPath: "old-name.ts" },
        ],
      })

      const { files } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(files, [
        new ChangedFile({
          path: "README.md",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 1,
          patch: TextPatch.make({ hunks: "@@ -1 +1 @@\n-Hello\n+Hello, world" }),
        }),
        new ChangedFile({
          path: "src/greet.ts",
          previousPath: null,
          changeType: "added",
          additions: 1,
          deletions: 0,
          patch: TextPatch.make({ hunks: "@@ -0,0 +1 @@\n+hi" }),
        }),
        new ChangedFile({
          path: "gone.txt",
          previousPath: null,
          changeType: "deleted",
          additions: 0,
          deletions: 1,
          patch: TextPatch.make({ hunks: "@@ -1 +0,0 @@\n-bye" }),
        }),
        new ChangedFile({
          path: "new-name.ts",
          previousPath: "old-name.ts",
          changeType: "renamed",
          additions: 0,
          deletions: 0,
          patch: NoTextChanges.make({}),
        }),
      ])
    }),
  )

  it.live("tells binary, too-large, and empty files apart", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base: { sha: "b0", files: {} },
        head: {
          sha: "h1",
          files: { "logo.png": "\u0089PNG\u0000\u0001", "big.txt": "x\n", "empty.txt": "" },
        },
        changedFiles: [
          { path: "logo.png", status: "added" },
          { path: "big.txt", status: "added", additions: 25000 },
          { path: "empty.txt", status: "added" },
        ],
      })

      const { files } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(
        files.map(({ path, patch }) => [path, patch._tag]),
        [
          ["logo.png", "BinaryFile"],
          ["big.txt", "PatchTooLarge"],
          ["empty.txt", "EmptyFile"],
        ],
      )
    }),
  )

  it.live("lists every file of a PR that changes more than a page of them", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend
      const paths = Array.from({ length: 250 }, (_, index) => `src/file-${index}.ts`)

      const pr = github.seedPullRequest({
        base: { sha: "b0", files: {} },
        head: { sha: "h1", files: Object.fromEntries(paths.map((path) => [path, "x\n"])) },
        changedFiles: paths.map((path) => ({ path, status: "added", additions: 1, patch: "@@" })),
      })

      const { files } = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(
        files.map((file) => file.path),
        paths,
      )
    }),
  )
})

describe("pinning", () => {
  it.live("rereads a PR that a push moves while its files load, so files match the Revision", () =>
    Effect.gen(function* () {
      const { github, client } = yield* startSignedInBackend

      const pr = github.seedPullRequest({
        base,
        head,
        changedFiles: [{ path: "README.md", status: "modified", additions: 1, deletions: 1 }],
      })

      const pushed = { sha: "h2", files: { ...head.files, "src/greet.ts": "hi\n" } }

      github.beforeNext("/repos/", () =>
        pr.push({
          head: pushed,
          changedFiles: [
            { path: "README.md", status: "modified", additions: 1, deletions: 1 },
            { path: "src/greet.ts", status: "added", additions: 1 },
          ],
        }),
      )

      const workspace = yield* client.OpenPullRequest({ pullRequest: new PullRequestRef(pr) })

      assert.deepStrictEqual(workspace.revision, new Revision({ base: "b0", head: "h2" }))
      assert.deepStrictEqual(
        workspace.files.map((file) => file.path),
        ["README.md", "src/greet.ts"],
      )
    }),
  )
})
