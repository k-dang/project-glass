import { existsSync, realpathSync } from "node:fs"
import { relative } from "node:path"
import { fileURLToPath } from "node:url"

export const root = realpathSync.native(fileURLToPath(new URL("../../../", import.meta.url)))

export const projectPath = (filename: string) =>
  relative(root, existsSync(filename) ? realpathSync.native(filename) : filename).replaceAll(
    "\\",
    "/",
  )

export const isTest = (filename: string) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) || /^(apps\/[^/]+\/(test|e2e)\/)/.test(filename)
