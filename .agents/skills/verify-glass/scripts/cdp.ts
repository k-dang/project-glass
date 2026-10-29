import { Schema } from "effect"

const Message = Schema.Union([
  Schema.Struct({ id: Schema.Int, result: Schema.Unknown }),
  Schema.Struct({ id: Schema.Int, error: Schema.Struct({ message: Schema.String }) }),
  Schema.Struct({ method: Schema.String }),
])

const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Message))

const Evaluation = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
  exceptionDetails: Schema.optional(
    Schema.Struct({
      text: Schema.String,
      exception: Schema.optional(Schema.Struct({ description: Schema.optional(Schema.String) })),
    }),
  ),
})

export class Cdp {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener("message", (event) => {
      try {
        const message = decodeMessage(String(event.data))
        if (!("id" in message)) return
        const waiter = this.pending.get(message.id)
        this.pending.delete(message.id)
        if ("error" in message) waiter?.reject(new Error(message.error.message))
        else waiter?.resolve(message.result)
      } catch (cause) {
        this.rejectPending(new Error("Invalid CDP message", { cause }))
        socket.close()
      }
    })
    socket.addEventListener("close", () => this.rejectPending(new Error("CDP target closed")))
  }

  private rejectPending(error: Error) {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }

  static open(url: string) {
    return new Promise<Cdp>((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener("open", () => resolve(new Cdp(socket)))
      socket.addEventListener("error", () => reject(new Error(`CDP connection to ${url} failed`)))
    })
  }

  async send<S extends Schema.ConstraintDecoder<unknown>>(
    method: string,
    response: S,
    params: object = {},
  ): Promise<S["Type"]> {
    const id = this.nextId++
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 15_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (cause) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(cause)
      }
    })
    return Schema.decodeUnknownSync(response)(result)
  }

  fire(method: string, params: object = {}) {
    this.socket.send(JSON.stringify({ id: this.nextId++, method, params }))
  }

  async evaluate<S extends Schema.ConstraintDecoder<unknown>>(expression: string, value: S) {
    const result = await this.send("Runtime.evaluate", Evaluation, {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      )
    }
    return Schema.decodeUnknownSync(value)(result.result.value)
  }

  close() {
    this.socket.close()
  }
}

export const cdpJson = async <S extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  response: S,
): Promise<S["Type"]> => {
  const result = await fetch(url)
  if (!result.ok) throw new Error(`CDP discovery returned HTTP ${result.status}`)
  return Schema.decodeUnknownSync(Schema.fromJsonString(response))(await result.text())
}
