import { Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import {
  HOST_TOKEN_HEADER,
  hostRecordPath,
  RecordedHost,
  SHUTDOWN_PATH,
} from "../src/agentHost/hostAddress.ts"

export const stopAgentHost = async (dataDirectory: string) => {
  const record = hostRecordPath(dataDirectory)

  if (!existsSync(record)) return

  const { port, token } = Schema.decodeUnknownSync(RecordedHost)(readFileSync(record, "utf8"))

  await fetch(`http://127.0.0.1:${port}${SHUTDOWN_PATH}`, {
    method: "POST",
    headers: { [HOST_TOKEN_HEADER]: token },
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined)
}
