import { lookup } from "node:dns/promises"
import { type AddressInfo, BlockList, connect, createServer, isIP, type Socket } from "node:net"
import { networkInterfaces } from "node:os"

const familyOf = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4")

const NOT_PUBLIC = new BlockList()

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["240.0.0.0", 4],
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, familyOf(network))

export const publicAddressCheck = () => {
  const thisDevice = new BlockList()

  for (const found of Object.values(networkInterfaces()).flat())
    if (found !== undefined) thisDevice.addAddress(found.address, familyOf(found.address))

  return (address: string) => {
    const family = familyOf(address)

    return (
      isIP(address) !== 0 &&
      !NOT_PUBLIC.check(address, family) &&
      !thisDevice.check(address, family)
    )
  }
}

const SOCKS_VERSION = 5

const NO_AUTHENTICATION = 0

const CONNECT = 1

const Reply = {
  succeeded: 0,
  failed: 1,
  notAllowed: 2,
  hostUnreachable: 4,
  refused: 5,
  notSupported: 7,
} as const

export const take = (socket: Socket, size: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const attempt = () => {
      const chunk: Buffer | null = socket.read(size)

      if (chunk === null) return

      stop()
      resolve(chunk)
    }

    const ended = () => {
      stop()
      reject(new Error("The client left during the SOCKS handshake"))
    }

    const stop = () => {
      socket.off("readable", attempt)
      socket.off("close", ended)
    }

    socket.on("readable", attempt)
    socket.on("close", ended)
    attempt()
  })

const replyOf = (code: number) => Buffer.from([SOCKS_VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0])

const ipv6Of = (bytes: Buffer) =>
  Array.from({ length: 8 }, (_, group) => bytes.readUInt16BE(group * 2).toString(16)).join(":")

const AddressType = { ipv4: 1, domain: 3, ipv6: 4 } as const

const hostOf = async (socket: Socket, type: number | undefined) => {
  switch (type) {
    case AddressType.ipv4:
      return [...(await take(socket, 4))].join(".")
    case AddressType.domain: {
      const [length = 0] = await take(socket, 1)

      return (await take(socket, length)).toString("latin1")
    }

    case AddressType.ipv6:
      return ipv6Of(await take(socket, 16))
    default:
      return null
  }
}

const destinationOf = async (socket: Socket) => {
  const [version, command, , type] = await take(socket, 4)
  const host = version === SOCKS_VERSION && command === CONNECT ? await hostOf(socket, type) : null

  return host === null ? null : { host, port: (await take(socket, 2)).readUInt16BE() }
}

const addressesOf = async (host: string) =>
  isIP(host) === 0 ? (await lookup(host, { all: true })).map(({ address }) => address) : [host]

const tunnel = (client: Socket, host: string, addresses: ReadonlyArray<string>, port: number) => {
  const upstream = connect({
    host,
    port,
    autoSelectFamily: true,
    lookup: (_hostname, _options, callback) =>
      callback(
        null,
        addresses.map((address) => ({ address, family: isIP(address) })),
      ),
  })

  let connected = false

  client.once("close", () => upstream.destroy())
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    if (connected) client.destroy()
    else client.end(replyOf(error.code === "ECONNREFUSED" ? Reply.refused : Reply.failed))
  })
  upstream.once("connect", () => {
    connected = true
    client.write(replyOf(Reply.succeeded))
    client.pipe(upstream).pipe(client)
    upstream.once("close", () => client.destroy())
  })
}

type ReachableCheck = () => (address: string) => boolean

const relay = async (client: Socket, reachable: ReachableCheck) => {
  const [version, methods = 0] = await take(client, 2)
  const offered = await take(client, methods)

  if (version !== SOCKS_VERSION || !offered.includes(NO_AUTHENTICATION)) {
    client.end(Buffer.from([SOCKS_VERSION, 0xff]))

    return
  }

  client.write(Buffer.from([SOCKS_VERSION, NO_AUTHENTICATION]))

  const destination = await destinationOf(client)

  if (destination === null) {
    client.end(replyOf(Reply.notSupported))

    return
  }

  const addresses = await addressesOf(destination.host).catch(() => null)

  if (client.destroyed) return

  const allowed = addresses?.filter(reachable()) ?? []

  if (allowed.length > 0) tunnel(client, destination.host, allowed, destination.port)
  else client.end(replyOf(addresses === null ? Reply.hostUnreachable : Reply.notAllowed))
}

export const startSandboxProxy = async (reachable: ReachableCheck) => {
  const server = createServer((client) => {
    client.on("error", () => client.destroy())
    relay(client, reachable).catch(() => client.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })

  // SAFETY: A server listening on a TCP host and port reports its AddressInfo.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Main can't load Schema before its window shows.
  const { port } = server.address() as AddressInfo

  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
