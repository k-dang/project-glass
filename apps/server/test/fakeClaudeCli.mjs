// It speaks the SDK's private stream-json control protocol, and saves sessions where the SDK's
// `getSessionInfo` looks for them, so it tracks the SDK version Glass pins; bumping the SDK may
// change what it has to say or where it saves.
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, watchFile } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const filename = fileURLToPath(import.meta.url)

const settingsFile = `${filename}.json`

const log = (entry) => appendFileSync(`${filename}.log`, `${JSON.stringify(entry)}\n`)

const settings = () => JSON.parse(readFileSync(settingsFile, "utf8"))

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)

const option = (name) =>
  process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)

const resume = option("--resume")

const sessionId = resume ?? option("--session-id") ?? randomUUID()

const sessionFile = path.join(
  process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
  "projects",
  process.cwd().replace(/[^a-zA-Z0-9]/g, "-"),
  `${sessionId}.jsonl`,
)

const refuse = (error) => {
  process.stderr.write(`${error}\n`)
  process.exit(1)
}

if (resume !== undefined && !existsSync(sessionFile))
  refuse(`No conversation found with session ID: ${sessionId}`)

if (resume === undefined && existsSync(sessionFile))
  refuse(`Error: Session ID ${sessionId} is already in use.`)

const modeFlag = process.argv.indexOf("--permission-mode")

const state = {
  model: "default",
  effort: null,
  mode: modeFlag === -1 ? "default" : process.argv[modeFlag + 1],
  turns: 0,
  heldPrompt: null,
  heldStart: null,
}

const asked = new Map()

const interrupted = Symbol("interrupted")

log({ kind: "launched", pid: process.pid, cwd: process.cwd() })

const models = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "For complex work",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    displayName: "Sonnet 5.5",
    description: "Most efficient for simpler tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  { value: "claude-haiku-4-5", displayName: "Haiku 4.5", description: "Fastest" },
]

const respond = (requestId, response) =>
  write({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  })

const message = (fields) => ({ session_id: sessionId, uuid: randomUUID(), ...fields })

const assistant = (content, parent) =>
  write(
    message({
      type: "assistant",
      parent_tool_use_id: parent ?? null,
      message: { id: `msg-${state.turns}`, role: "assistant", content },
    }),
  )

const stream = (event, answered = []) => {
  const record = message({ type: "stream_event", parent_tool_use_id: null, event })

  if (answered.length > 0) {
    record.user_message_uuid = answered.at(-1)
    record.user_message_uuids = answered
  }

  write(record)
}

const toolResult = (id, output, isError, parent) =>
  write(
    message({
      type: "user",
      parent_tool_use_id: parent ?? null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: isError }],
      },
    }),
  )

const ask = (toolName, input, toolUseId) =>
  new Promise((resolve) => {
    const requestId = randomUUID()
    asked.set(requestId, resolve)
    write({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "can_use_tool", tool_name: toolName, input, tool_use_id: toolUseId },
    })
  })

const editTools = new Set(["Edit", "Write", "NotebookEdit"])

const readTools = new Set(["Read", "Glob", "Grep"])

/** What Claude Code does before running a tool in each Permission mode, as far as the tests need. */
const policy = (name) => {
  if (name === "AskUserQuestion") return "ask"

  if (readTools.has(name) || state.mode === "bypassPermissions") return "allow"

  if (editTools.has(name)) {
    // In auto mode, a classifier decides; the fake's stands in by approving edits.
    return state.mode === "acceptEdits" || state.mode === "auto" ? "allow" : "ask"
  }

  // Commands are what auto mode's classifier asks the user about when it can't decide.
  return "ask"
}

const run = async ({ id, name, input, output, isError, parentToolCallId }) => {
  const decision = policy(name)

  if (decision === "allow") return toolResult(id, output, isError ?? false, parentToolCallId)

  const answer = await ask(name, input, id)

  if (answer === interrupted) return interrupted

  log({ kind: "permission", toolName: name, answer })

  if (answer.behavior === "deny") return toolResult(id, answer.message, true, parentToolCallId)

  const answered = answer.updatedInput?.answers

  return toolResult(
    id,
    answered === undefined ? output : JSON.stringify(answered),
    isError ?? false,
    parentToolCallId,
  )
}

const reply = async (steps, earlier) => {
  let index = 0

  for (const step of steps) {
    if (step.text !== undefined || step.thinking !== undefined) {
      const type = step.text !== undefined ? "text" : "thinking"
      const text = step.text === undefined ? step.thinking : echo(step.text, earlier)
      stream({ type: "content_block_start", index, content_block: { type, [type]: "" } })

      for (const piece of text.match(/.{1,4}/gs) ?? [])
        stream({
          type: "content_block_delta",
          index,
          delta: { type: `${type}_delta`, [type]: piece },
        })

      assistant([{ type, [type]: text }])
      stream({ type: "content_block_stop", index })
      index++
    } else if (step.toolCall !== undefined) {
      const { id, name, input, parentToolCallId } = step.toolCall
      assistant([{ type: "tool_use", id, name, input }], parentToolCallId)

      if ((await run(step.toolCall)) === interrupted) return interrupted
    }
  }

  return undefined
}

const echo = (text, earlier) =>
  text
    .replaceAll("{model}", state.model)
    .replaceAll("{effort}", state.effort ?? "default")
    .replaceAll("{earlier}", earlier.join(" | "))

const savedPrompts = () =>
  existsSync(sessionFile)
    ? readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line).message.content)
    : []

const save = (prompt) => {
  mkdirSync(path.dirname(sessionFile), { recursive: true })
  appendFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "user",
      sessionId,
      uuid: randomUUID(),
      cwd: process.cwd(),
      message: { role: "user", content: prompt },
    })}\n`,
  )
}

const blocks = (content) => (Array.isArray(content) ? content : [{ type: "text", text: content }])

const textOf = (content) =>
  blocks(content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")

const imagesOf = (content) =>
  blocks(content)
    .filter((block) => block.type === "image")
    .map((block) => block.source.media_type)

const result = (fields) =>
  write(message({ type: "result", duration_ms: 1, num_turns: 1, ...fields }))

const defaultReply = [{ text: "Hello from Claude Code." }]

const finish = async (current, answered, steps, earlier = []) => {
  stream(
    { type: "message_start", message: { id: `msg-${state.turns}`, role: "assistant" } },
    answered,
  )

  if ((await reply(steps, earlier)) === interrupted) return
  stream({ type: "message_stop" })

  const failed = current.error !== undefined

  result({
    subtype: "success",
    is_error: failed,
    api_error_status: current.error?.status ?? null,
    result: failed ? current.error.message : "done",
    stop_reason: "end_turn",
  })
  log({ kind: "replied" })
}

const answer = async (record) => {
  state.turns++
  const current = settings()
  const { content } = record.message
  const prompt = textOf(content)

  log({
    kind: "prompt",
    prompt,
    images: imagesOf(content),
    model: state.model,
    effort: state.effort,
  })
  const earlier = savedPrompts()
  save(prompt)

  if (state.turns === 1)
    write(message({ type: "system", subtype: "init", cwd: process.cwd(), model: state.model }))

  if (current.exit) process.exit(1)

  const answered = record.uuid === undefined ? [] : [record.uuid]

  if (current.hang) {
    state.heldPrompt = { answered, earlier }

    return
  }

  const steps = current.reply ?? defaultReply

  if (current.replyDelayMillis === undefined) await finish(current, answered, steps, earlier)
  else setTimeout(() => void finish(current, answered, steps, earlier), current.replyDelayMillis)
}

const steer = (record) => {
  const { content } = record.message
  const answered = [...state.heldPrompt.answered, record.uuid]
  state.heldPrompt = null
  void finish(settings(), answered, [{ text: `Taken in: ${textOf(content)}` }])
}

// Like Claude Code, an interrupt cancels the permission questions it's waiting on and ends the Turn.
const interrupt = (requestId) => {
  const held = state.heldPrompt
  const waiting = [...asked]
  state.heldPrompt = null
  asked.clear()
  respond(requestId, { still_queued: [], cancelled: [] })

  for (const [askedId, resolve] of waiting) {
    write({ type: "control_cancel_request", request_id: askedId })
    resolve(interrupted)
  }

  if (held !== null || waiting.length > 0)
    result({ subtype: "error_during_execution", is_error: true, errors: [] })
}

watchFile(settingsFile, { interval: 20 }, () => {
  const current = settings()

  if (state.heldStart !== null && !current.holdStart) {
    respond(state.heldStart, initialized)
    state.heldStart = null
  }

  if (state.heldPrompt === null || current.hang) return

  const { answered, earlier } = state.heldPrompt
  state.heldPrompt = null
  void finish(current, answered, current.reply ?? defaultReply, earlier)
})

const initialized = {
  commands: [],
  agents: [],
  models,
  account: {},
  pid: process.pid,
  output_style: "default",
  available_output_styles: ["default"],
}

const control = (request) => {
  if (request.subtype === "initialize") return initialized

  if (request.subtype === "set_model") state.model = request.model ?? "default"

  if (request.subtype === "apply_flag_settings" && "effortLevel" in request.settings)
    state.effort = request.settings.effortLevel

  if (request.subtype === "set_permission_mode") state.mode = request.mode

  return { model: state.model }
}

let turns = Promise.resolve()

const handle = (record) => {
  if (record.type === "control_request") {
    log({ kind: "control", request: record.request })

    if (record.request.subtype === "interrupt") interrupt(record.request_id)
    else if (record.request.subtype === "initialize" && settings().holdStart)
      state.heldStart = record.request_id
    else respond(record.request_id, control(record.request))
  }

  if (record.type === "control_response") {
    const resolve = asked.get(record.response.request_id)
    asked.delete(record.response.request_id)
    resolve?.(record.response.response)
  }

  if (record.type !== "user") return

  if (state.heldPrompt !== null && record.priority === "next") steer(record)
  // Turns run one after another, as a message sent mid-Turn waits for the Turn to end.
  else turns = turns.then(() => answer(record))
}

let pending = ""

process.stdin.setEncoding("utf8")

process.stdin.on("data", (chunk) => {
  pending += chunk
  let end = pending.indexOf("\n")

  while (end !== -1) {
    const line = pending.slice(0, end)
    pending = pending.slice(end + 1)

    if (line.trim() !== "") handle(JSON.parse(line))
    end = pending.indexOf("\n")
  }
})

process.stdin.on("end", () => process.exit(0))
