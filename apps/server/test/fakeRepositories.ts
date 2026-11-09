import { createHash } from "node:crypto"

export class ExecutableFile {
  readonly contents: string

  constructor(contents: string) {
    this.contents = contents
  }
}

type FakeFile = string | ExecutableFile

export type FakeFiles = Readonly<Record<string, FakeFile>>

interface FakeRepository {
  defaultBranch: string | null
  readonly refs: Map<string, string>
  readonly commits: Map<string, FakeFiles>
}

const sha1 = (...parts: ReadonlyArray<string | Buffer>) => {
  const hash = createHash("sha1")

  for (const part of parts) hash.update(part)

  return hash.digest("hex")
}

const contentsOf = (file: FakeFile) =>
  Buffer.from(file instanceof ExecutableFile ? file.contents : file)

export const blobSha = (contents: string | Buffer) => {
  const bytes = Buffer.from(contents)

  return sha1(`blob ${bytes.length}\0`, bytes)
}

const within = (folder: string, path: string) =>
  folder === "" ? path : path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : null

interface Repository {
  readonly owner: string
  readonly repo: string
}

const keyOf = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()

export const fakeRepositories = () => {
  const repositories = new Map<string, FakeRepository>()
  const trees = new Map<string, { readonly commit: string; readonly path: string }>()
  const blobs = new Map<string, Buffer>()
  let pushes = 0

  const treeOid = (commit: string, path: string) => {
    const oid = sha1("tree", commit, ":", path)
    trees.set(oid, { commit, path })

    return oid
  }

  const resolve = (repository: FakeRepository, revision: string) => {
    const branch = repository.refs.get(
      revision === "HEAD" ? (repository.defaultBranch ?? "") : revision,
    )

    if (branch !== undefined) return branch

    if (!/^[0-9a-f]{7,40}$/.test(revision)) return null

    return [...repository.commits.keys()].find((sha) => sha.startsWith(revision)) ?? null
  }

  const repositoryAt = (key: string, defaultBranch: string | null) => {
    const repository = repositories.get(key) ?? {
      defaultBranch,
      refs: new Map(),
      commits: new Map(),
    }

    repositories.set(key, repository)

    return repository
  }

  const commitTo = (repository: FakeRepository, key: string, ref: string, files: FakeFiles) => {
    const commit = sha1("commit", key, ref, String(++pushes))

    repository.commits.set(commit, files)
    repository.refs.set(ref, commit)

    return commit
  }

  return {
    seedBranches: (
      { owner, repo }: Repository,
      seed: { readonly defaultBranch: string | null; readonly branches: ReadonlyArray<string> },
    ) => {
      const key = keyOf(owner, repo)
      const repository = repositoryAt(key, seed.defaultBranch)

      repository.defaultBranch = seed.defaultBranch
      repository.refs.clear()

      for (const branch of seed.branches) commitTo(repository, key, branch, {})
    },

    push: ({ owner, repo }: Repository, ref: string, files: FakeFiles) => {
      const key = keyOf(owner, repo)
      const repository = repositoryAt(key, ref)

      for (const file of Object.values(files)) {
        const bytes = contentsOf(file)
        blobs.set(blobSha(bytes), bytes)
      }

      return commitTo(repository, key, ref, files)
    },

    branches: (owner: string, repo: string) => {
      const repository = repositories.get(keyOf(owner, repo))

      return repository === undefined ? undefined : [...repository.refs.keys()]
    },

    defaultBranch: (owner: string, repo: string) =>
      repositories.get(keyOf(owner, repo))?.defaultBranch,

    commit: (owner: string, repo: string, revision: string) => {
      const repository = repositories.get(keyOf(owner, repo))

      return repository === undefined ? undefined : resolve(repository, revision)
    },

    folder: (owner: string, repo: string, expression: string) => {
      const repository = repositories.get(keyOf(owner, repo))

      if (repository === undefined) return undefined

      const separator = expression.indexOf(":")
      const revision = separator === -1 ? expression : expression.slice(0, separator)
      const path = separator === -1 ? "" : expression.slice(separator + 1).replace(/\/$/, "")
      const commit = resolve(repository, revision)

      if (commit === null) return null

      const isFolder =
        path === "" ||
        Object.keys(repository.commits.get(commit)!).some((file) => within(path, file) !== null)

      return isFolder
        ? {
            kind: separator === -1 ? ("commit" as const) : ("tree" as const),
            oid: treeOid(commit, path),
          }
        : null
    },

    tree: (owner: string, repo: string, oid: string) => {
      const tree = trees.get(oid)
      const files = repositories.get(keyOf(owner, repo))?.commits.get(tree?.commit ?? "")

      if (tree === undefined || files === undefined) return undefined

      return Object.entries(files)
        .flatMap(([path, file]) => {
          const relative = within(tree.path, path)

          return relative === null
            ? []
            : [
                {
                  path: relative,
                  mode: file instanceof ExecutableFile ? "100755" : "100644",
                  type: "blob",
                  sha: blobSha(contentsOf(file)),
                },
              ]
        })
        .toSorted((a, b) => (a.path < b.path ? -1 : 1))
    },

    blob: (sha: string) => blobs.get(sha),
  }
}
