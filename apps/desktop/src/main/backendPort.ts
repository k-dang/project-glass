import { Option, Schema } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"

const decodeAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }))

const PORT_FILE = "backend-port"

const listen = (port: number) =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()

      server.close(() => {
        const decoded = decodeAddress(address)

        if (Option.isSome(decoded)) resolve(decoded.value.port)
        else reject(new Error("No listening port"))
      })
    })
  })

/**
 * Reuse the port the backend last bound, so the MCP address outside agents saved stays valid,
 * and take another only when that port is already taken.
 */
export const choosePort = async (directory: string): Promise<number> => {
  await mkdir(directory, { recursive: true })

  const remembered = Number(
    (await readFile(join(directory, PORT_FILE), "utf8").catch(() => "")).trim(),
  )

  const reusable = Number.isInteger(remembered) && remembered > 0 && remembered < 65536
  const port = reusable ? await listen(remembered).catch(() => listen(0)) : await listen(0)

  await writeFile(join(directory, PORT_FILE), `${port}\n`, { mode: 0o600 })

  return port
}
