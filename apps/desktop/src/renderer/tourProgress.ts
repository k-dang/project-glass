import { type ViewedFilesStore, useViewedFiles } from "./useViewedFiles"

export const twoDigits = (count: number) => String(count).padStart(2, "0")

/** Some paths, all of them viewed: a Chapter or group is done; a file-free one never is. */
export const allViewed = (paths: ReadonlyArray<string>, viewed: ReadonlySet<string>) =>
  paths.length > 0 && paths.every((path) => viewed.has(path))

export const useProgress = (store: ViewedFilesStore, paths: ReadonlyArray<string>) => {
  const { viewed, locked } = useViewedFiles(store)
  const count = paths.filter((path) => viewed.has(path)).length

  return { count, total: paths.length, done: allViewed(paths, viewed), locked }
}
