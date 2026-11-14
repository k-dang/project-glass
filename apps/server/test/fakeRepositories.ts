import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { Header, Pax } from "tar"
import { gitBlobSha } from "../src/skillPackArchive.ts"

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

export const blobSha = (contents: string | Buffer) => gitBlobSha(Buffer.from(contents))

const tarEntry = (path: string, contents: Buffer, mode: number) => {
  const data = { path, mode, size: contents.length, type: "File" as const, mtime: new Date(0) }
  const header = new Header(data)
  const pax = header.encode() ? [new Pax(data).encode()] : []
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512)

  return [...pax, header.block!, contents, padding]
}

const tarball = (root: string, commit: string, files: FakeFiles) =>
  gzipSync(
    Buffer.concat([
      new Pax({ path: "pax_global_header", comment: commit }, true).encode(),
      ...Object.entries(files).flatMap(([path, file]) =>
        tarEntry(
          `${root}/${path}`,
          contentsOf(file),
          file instanceof ExecutableFile ? 0o775 : 0o664,
        ),
      ),
      Buffer.alloc(1024),
    ]),
  )

interface Repository {
  readonly owner: string
  readonly repo: string
}

const keyOf = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase()

export const fakeRepositories = () => {
  const repositories = new Map<string, FakeRepository>()
  let pushes = 0

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

    tarball: (owner: string, repo: string, revision: string) => {
      const repository = repositories.get(keyOf(owner, repo))

      if (repository === undefined) return undefined

      const commit = resolve(repository, revision)

      return commit === null
        ? undefined
        : tarball(`${owner}-${repo}-${commit.slice(0, 7)}`, commit, repository.commits.get(commit)!)
    },
  }
}
