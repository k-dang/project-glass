import { Effect } from "effect"
import { createHash } from "node:crypto"
import { Parser } from "tar"

export interface ArchiveFile {
  readonly path: string
  readonly sha: string
  readonly executable: boolean
  readonly contents: Uint8Array
}

export const gitBlobSha = (contents: Uint8Array) =>
  createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex")

const within = (folder: string, path: string) => {
  if (folder === "") return path

  if (path === folder) return ""

  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : null
}

// WARNING: Every entry of a GitHub repository tarball sits under one <owner>-<repo>-<sha>/ folder.
export const filesInArchive = (archive: Uint8Array, folder: string) =>
  Effect.callback<ReadonlyArray<ArchiveFile> | null, Error>((resume) => {
    const files: Array<ArchiveFile> = []
    let found = folder === ""

    const parser = new Parser({
      strict: true,
      onReadEntry: (entry) => {
        const inRepository = entry.path.slice(entry.path.indexOf("/") + 1).replace(/\/$/, "")
        const path = within(folder, inRepository)

        if (path !== null) found = true

        if (path === null || path === "" || entry.type !== "File") return entry.resume()

        const chunks: Array<Buffer> = []

        entry.on("data", (chunk: Buffer) => chunks.push(chunk))
        entry.on("end", () => {
          const contents = Buffer.concat(chunks)

          files.push({
            path,
            sha: gitBlobSha(contents),
            executable: ((entry.mode ?? 0) & 0o100) !== 0,
            contents,
          })
        })
      },
    })

    parser.on("error", (error: Error) => resume(Effect.fail(error)))
    parser.on("end", () => resume(Effect.succeed(found ? files : null)))
    parser.end(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength))
  })
