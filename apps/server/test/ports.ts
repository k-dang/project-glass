import { Schema } from "effect"
import type { Server } from "node:net"

const Address = Schema.Struct({ port: Schema.Int })

const decodeAddress = Schema.decodeUnknownSync(Address)

export const portOf = (server: Server) => decodeAddress(server.address()).port
