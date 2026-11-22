import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { isolatedGitEnv } from "../src/gitEnv.ts"

const env = {
  ...isolatedGitEnv(),
  GIT_AUTHOR_NAME: "Glass Test",
  GIT_AUTHOR_EMAIL: "test@glass.invalid",
  GIT_COMMITTER_NAME: "Glass Test",
  GIT_COMMITTER_EMAIL: "test@glass.invalid",
}

export const gitIn = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim()

export const fastImportData = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`

export const seedClone = (directory: string, owner: string, repo: string) => {
  const origin = join(directory, `${repo}-origin.git`)
  const checkout = join(directory, repo)
  const url = `https://github.com/${owner}/${repo}.git`
  const now = Math.floor(Date.now() / 1000)

  mkdirSync(directory, { recursive: true })
  gitIn(directory, "init", "--quiet", "--bare", "--initial-branch=main", origin)
  execFileSync("git", ["-C", origin, "fast-import", "--quiet"], {
    env,
    input: [
      "commit refs/heads/main\n",
      `committer ${env.GIT_COMMITTER_NAME} <${env.GIT_COMMITTER_EMAIL}> ${now} +0000\n`,
      fastImportData("Start"),
      `M 100644 inline README.md\n${fastImportData(`# ${repo}\n`)}`,
      "reset refs/heads/develop\nfrom refs/heads/main\n",
    ].join(""),
  })
  gitIn(directory, "clone", "--quiet", "-c", `url.${origin}.insteadOf=${url}`, url, checkout)

  return { checkout, origin, main: gitIn(checkout, "rev-parse", "origin/main") }
}
