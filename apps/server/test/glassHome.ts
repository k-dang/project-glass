import { Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import {
  HOST_TOKEN_HEADER,
  hostRecordPath,
  RecordedHost,
  SHUTDOWN_PATH,
} from "../src/agentHost/hostAddress.ts"

export const stopAgentHost = async (home: string) => {
  const record = hostRecordPath(join(home, ".project-glass"))

  if (!existsSync(record)) return

  const { port, token } = Schema.decodeUnknownSync(RecordedHost)(readFileSync(record, "utf8"))

  await fetch(`http://127.0.0.1:${port}${SHUTDOWN_PATH}`, {
    method: "POST",
    headers: { [HOST_TOKEN_HEADER]: token },
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined)
}

// WARNING: On Windows the folder stays locked until the stopped host and its agents exit, and exiting Claude Code processes still write session files into it, so rm retries.
export const removeFolder = (folder: string) =>
  rm(folder, { recursive: true, force: true, maxRetries: 20 })

export const removeGlassHome = async (home: string) => {
  await stopAgentHost(home)
  await removeFolder(home)
}
