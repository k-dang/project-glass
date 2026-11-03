import { vi } from "vite-plus/test"

// For tests without a DOM; DOM tests use Testing Library's waitFor, which needs one.
export const eventually = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 25_000 })
