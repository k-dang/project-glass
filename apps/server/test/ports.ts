import { Schema } from "effect"
import { createServer, type Server } from "node:net"

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))

export const portOf = (server: Server) => decodeAddress(server.address()).port

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = portOf(server)
      server.close(() => resolve(port))
    })
  })
