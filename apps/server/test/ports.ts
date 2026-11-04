import { Schema } from "effect"
import type { ChildProcess } from "node:child_process"
import type { Server } from "node:net"
import { Readable } from "node:stream"
import { text } from "node:stream/consumers"

const Address = Schema.Struct({ port: Schema.Int })

const decodeAddress = Schema.decodeUnknownSync(Address)

export const portOf = (server: Server) => decodeAddress(server.address()).port

export const hostPort = async (host: ChildProcess) => {
  const ready = host.stdio[3]

  if (!(ready instanceof Readable)) throw new Error("The host has no readiness pipe")

  return Schema.decodeUnknownSync(Schema.fromJsonString(Address))(await text(ready)).port
}
