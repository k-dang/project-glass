import { Effect } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { HttpEffect, type HttpServerRequest } from "effect/http"
import { createHash } from "node:crypto"

export const MCP_PATH = "/mcp"

export const digest = (bearer: string) => createHash("sha256").update(bearer).digest("hex")

export const SESSION_HEADER = "mcp-session-id"

export const ownsSession = (
  request: HttpServerRequest.HttpServerRequest,
  ownedSessions: ReadonlySet<string>,
) => {
  const session = request.headers[SESSION_HEADER]

  return session === undefined || ownedSessions.has(session)
}

// WARNING: Effect sets an opened session's id in its own pre-response handler, so read it after.
export const claimOpenedSession = (ownedSessions: Set<string>) =>
  HttpEffect.appendPreResponseHandler((_, final) =>
    Effect.sync(() => {
      const opened = final.headers[SESSION_HEADER]

      if (opened !== undefined) ownedSessions.add(opened)

      return final
    }),
  )

export const glassMcpHttp = () =>
  McpServer.layerHttp({
    name: "glass",
    version: "1.0.0",
    path: MCP_PATH,
    protocols: [McpProtocol.v2025_11_25],
    allowedOrigins: [],
    // WARNING: Effect never expires MCP sessions, so clients must be allowed to end their own.
    allowSessionTermination: true,
  })
