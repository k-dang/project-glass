import { once } from "node:events"
import { Schema } from "effect"
import { connect, createServer, type Server, type Socket } from "node:net"
import { afterEach, describe, expect, it } from "vite-plus/test"
import { publicAddressCheck, startSandboxProxy, take } from "./sandboxProxy"

describe("publicAddressCheck", () => {
  it.each(["93.184.215.14", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "lets %s through",
    (address) => expect(publicAddressCheck()(address)).toBe(true),
  )

  it.each([
    "127.0.0.1",
    "127.12.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.31.255.255",
    "192.168.1.1",
    "100.100.100.100",
    "169.254.169.254",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:0:0",
    "0:0:0:0:0:ffff:c0a8:101",
    "::7f00:1",
    "fd7a:115c:a1e0::1",
    "fe80::1",
    "localhost",
  ])("refuses %s", (address) => expect(publicAddressCheck()(address)).toBe(false))
})

const opened: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map(({ close }) => close()))
})

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))

const echoServer = async () => {
  const connections: Array<Socket> = []

  const server: Server = createServer((socket) => {
    connections.push(socket)
    socket.pipe(socket)
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  opened.push({
    close: () => {
      for (const socket of connections) socket.destroy()

      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  })

  return { port: decodeAddress(server.address()).port }
}

const proxy = async (reachable: Parameters<typeof startSandboxProxy>[0]) => {
  const started = await startSandboxProxy(reachable)

  opened.push(started)

  return started.port
}

const socksConnect = async (proxyPort: number, host: string, port: number) => {
  const socket = connect({ host: "127.0.0.1", port: proxyPort })

  opened.push({ close: async () => void socket.destroy() })
  await once(socket, "connect")
  socket.write(Buffer.from([5, 1, 0]))
  expect([...(await take(socket, 2))]).toEqual([5, 0])

  const name = Buffer.from(host)
  const target = Buffer.alloc(2)
  target.writeUInt16BE(port)
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, target]))

  const [, reply] = await take(socket, 10)

  return { reply, socket }
}

describe("startSandboxProxy", () => {
  it("connects a client to the address it checked", async () => {
    const echo = await echoServer()
    const port = await proxy(() => (address) => address === "127.0.0.1")

    const { reply, socket } = await socksConnect(port, "localhost", echo.port)
    socket.write("hello")

    expect({ reply, echoed: (await take(socket, 5)).toString() }).toEqual({
      reply: 0,
      echoed: "hello",
    })
  })

  it("refuses a name that resolves to this device", async () => {
    const echo = await echoServer()
    const port = await proxy(publicAddressCheck)

    expect((await socksConnect(port, "localhost", echo.port)).reply).toBe(2)
  })
})
