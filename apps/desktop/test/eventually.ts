import { vi } from "vite-plus/test"

export const eventually = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 25_000 })
