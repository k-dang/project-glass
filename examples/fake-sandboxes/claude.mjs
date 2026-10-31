// A stand-in for Claude Code that speaks just enough of the Agent SDK's stream-json protocol to
// answer each message with a canned reply. The protocol is the SDK's private one, so a Glass that
// pins a newer SDK may need more from it.
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"

const sessionId = randomUUID()

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)

const message = (fields) => ({ session_id: sessionId, uuid: randomUUID(), ...fields })

const stream = (event) => write(message({ type: "stream_event", parent_tool_use_id: null, event }))

const respond = (requestId, response) =>
  write({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  })

const initialized = {
  commands: [],
  agents: [],
  models: [{ value: "fake-model", displayName: "Fake model", description: "Canned replies" }],
  account: {},
  pid: process.pid,
  output_style: "default",
  available_output_styles: ["default"],
}

const textOf = (content) =>
  Array.isArray(content)
    ? content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
    : content

let turns = 0

const reply = (record) => {
  turns++

  if (turns === 1)
    write(message({ type: "system", subtype: "init", cwd: process.cwd(), model: "fake-model" }))

  const text = `Fake reply to: ${textOf(record.message.content)}`
  write(
    message({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: `msg-${turns}`, role: "assistant" } },
      user_message_uuid: record.uuid,
    }),
  )
  stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
  write(
    message({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: `msg-${turns}`, role: "assistant", content: [{ type: "text", text }] },
    }),
  )
  stream({ type: "content_block_stop", index: 0 })
  stream({ type: "message_stop" })
  write(
    message({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      stop_reason: "end_turn",
      duration_ms: 1,
      num_turns: 1,
    }),
  )
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return

  const record = JSON.parse(line)

  if (record.type === "control_request")
    respond(record.request_id, record.request.subtype === "initialize" ? initialized : {})

  if (record.type === "user") reply(record)
})
