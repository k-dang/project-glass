import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isolatedGitEnv } from "../src/gitEnv"

const env = {
  ...isolatedGitEnv(),
  GIT_AUTHOR_NAME: "Glass Test",
  GIT_AUTHOR_EMAIL: "test@glass.invalid",
  GIT_COMMITTER_NAME: "Glass Test",
  GIT_COMMITTER_EMAIL: "test@glass.invalid",
}

export const gitIn = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim()

export const seedClone = (directory: string, owner: string, repo: string) => {
  const origin = join(directory, `${repo}-origin.git`)
  const seed = join(directory, `${repo}-seed`)
  const checkout = join(directory, repo)
  const url = `https://github.com/${owner}/${repo}.git`

  mkdirSync(seed, { recursive: true })
  gitIn(directory, "init", "--quiet", "--bare", "--initial-branch=main", origin)
  gitIn(seed, "init", "--quiet", "--initial-branch=main")
  writeFileSync(join(seed, "README.md"), `# ${repo}\n`)
  gitIn(seed, "add", ".")
  gitIn(seed, "commit", "--quiet", "-m", "Start")
  gitIn(seed, "branch", "develop")
  gitIn(seed, "push", "--quiet", origin, "main", "develop")
  gitIn(directory, "clone", "--quiet", origin, checkout)
  gitIn(checkout, "remote", "set-url", "origin", url)
  gitIn(checkout, "config", `url.${origin}.insteadOf`, url)

  return { checkout, origin, main: gitIn(checkout, "rev-parse", "origin/main") }
}
