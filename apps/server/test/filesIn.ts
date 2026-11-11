import { readdirSync } from "node:fs"
import { join, relative } from "node:path"

export const filesIn = (directory: string) =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .filter((path) => !path.startsWith(".git/"))
    .toSorted()
