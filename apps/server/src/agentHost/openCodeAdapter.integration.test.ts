import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Predicate, Scope, Exit, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { execFileSync } from "node:child_process"
import { mkdir, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { drive, lastTextOf, runningTool } from "../../test/adapterSessions"
import {
  fakeModelProvider,
  lastUserText,
  type FakeModelSettings,
} from "../../test/fakeModelProvider"
import { isolatedHome, stubHome } from "../../test/harness"
import { openCodeSessionTape } from "../../test/openCodeSessionTape"
import { vi } from "vite-plus/test"
import { AnswerQuestion, AllowRequest, DenyRequest } from "@glass/contracts"
import { settled } from "../../test/agentsFixture"
import { recordingSessions } from "../../test/sessionTape"
import { openCodeAdapter } from "./openCodeAdapter"

const fixture = Effect.fnUntraced(function* (
  scenario: string,
  settings: FakeModelSettings,
  model = "glass-test/gpt-test",
) {
  const home = yield* isolatedHome
  stubHome(home)
  vi.stubEnv("GLASS_HOME", home)
  vi.stubEnv("OPENCODE_TEST_HOME", home)

  for (const kind of ["CONFIG", "DATA", "STATE", "CACHE"])
    vi.stubEnv(`XDG_${kind}_HOME`, join(home, kind.toLowerCase()))
  const provider = yield* fakeModelProvider(home, settings)
  const folder = join(home, "work")
  yield* Effect.promise(() => mkdir(folder))
  execFileSync("git", ["init", "--quiet", folder], { windowsHide: true })
  yield* Effect.promise(() =>
    writeFile(
      join(folder, "opencode.json"),
      JSON.stringify({
        model,
        permission: { bash: "ask" },
        command: { greet: { template: "Say hello", description: "Greet" } },
        enabled_providers: ["glass-test"],
        provider: {
          "glass-test": {
            npm: "@ai-sdk/openai-compatible",
            name: "Glass test",
            options: { baseURL: provider.url, apiKey: "test-key" },
            models: {
              "gpt-test": {
                name: "Glass test",
                attachment: true,
                modalities: { input: ["text", "image"], output: ["text"] },
                limit: { context: 128000, output: 4096 },
              },
              "gpt-test-thinking": {
                name: "Thinking",
                reasoning: true,
                limit: { context: 128000, output: 4096 },
                variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } },
              },
            },
          },
        },
      }),
    ),
  )

  const tape = openCodeSessionTape(scenario, {
    "<workdir>": folder,
    "<provider>": provider.url,
    "<test-home>": home,
    "<native-workdir-path>": folder.replace(/^[A-Za-z]:[\\/]/, "").replaceAll("\\", "/"),
  })

  const adapter = yield* openCodeAdapter(
    recordingSessions
      ? (process.env["GLASS_OPENCODE_COMMAND"] ?? "opencode")
      : "glass-recorded-opencode",
    tape.start,
  )

  const test = yield* drive(adapter, tape, folder)

  return { ...test, provider, tape }
})

const check = (
  body: Effect.Effect<
    void,
    unknown,
    Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >,
) => body.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

it.live(
  "OpenCode streams a conversation, validates settings, and resumes after model errors or restart",
  () =>
    check(
      Effect.gen(function* () {
        const test = yield* fixture("conversation", {
          reply: (input) =>
            lastUserText(input) === "Use a tool" && input.messages.at(-1)?.role !== "tool"
              ? [
                  {
                    toolCall: {
                      id: "native-call",
                      name: "bash",
                      arguments: { command: "echo OPENCODE_TOOL_OK", description: "Echo a marker" },
                    },
                  },
                ]
              : [
                  { thinking: "Thinking about the reply." },
                  { text: "Hello from native OpenCode." },
                ],
        })

        const firstScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
        const agent = yield* test.open("test-conversation").pipe(Scope.provide(firstScope))
        yield* agent.configure({
          permissionMode: "bypassPermissions",
          model: "glass-test/gpt-test-thinking",
          effort: "high",
        })
        const badModel = yield* agent.configure({ model: "glass-test/missing" }).pipe(Effect.flip)
        assert.include(badModel.message, "model")

        const badEffort = yield* agent
          .configure({ model: "glass-test/gpt-test", effort: "high" })
          .pipe(Effect.flip)

        assert.include(badEffort.message, "effort")
        yield* agent.send("Use a tool")
        const first = yield* test.until(settled(1))
        assert.equal(lastTextOf(first.at(-1)), "Hello from native OpenCode.")
        assert.isTrue(
          first[0]!.parts.some(
            (part) =>
              Predicate.isTagged(part, "ToolCall") &&
              part.status === "done" &&
              part.output?.includes("OPENCODE_TOOL_OK"),
          ),
        )
        assert.isTrue(first[0]!.parts.some((part) => Predicate.isTagged(part, "Thinking")))
        yield* Scope.close(firstScope, Exit.void)
        const restored = yield* test.open("test-conversation")
        yield* restored.configure({
          model: "glass-test/gpt-test-thinking",
          effort: null,
          permissionMode: "bypassPermissions",
        })
        yield* restored.send("Reset effort")
        yield* test.until(settled(2))

        if (recordingSessions) assert.equal(test.provider.calls.at(-1)!.reasoning_effort, undefined)
        yield* restored.configure({
          model: null,
          effort: null,
          permissionMode: "bypassPermissions",
        })
        yield* restored.send("Say hello again")
        yield* test.until(settled(3))
        yield* restored.send("Continue after restart")
        const final = yield* test.until(settled(4))
        assert.equal(lastTextOf(final.at(-1)), "Hello from native OpenCode.")
        assert.equal(
          test.events.filter((event) => Predicate.isTagged(event, "TurnEnded")).length,
          4,
        )

        if (recordingSessions) {
          assert.equal(test.provider.calls[0]!.model, "gpt-test-thinking")
          assert.equal(test.provider.calls[0]!.reasoning_effort, "high")
          assert.equal(test.provider.calls.at(-1)!.model, "gpt-test")
          assert.isTrue(
            test.provider.calls
              .at(-1)!
              .messages.some((message) => message.content === "Use a tool"),
          )
        }

        yield* test.provider.configure({
          failFirst: test.provider.calls.length + 1,
          failureStatus: 401,
          failureMessage: "Invalid API key",
          output: "RECOVERED",
        })
        yield* restored.send("Reject this request")
        const rejected = yield* test.until(settled(5))
        assert.equal(rejected[4]!.ended!.ending._tag, "Failed")
        yield* restored.send("Try a fresh Turn")
        const recovered = yield* test.until(settled(6))
        assert.equal(recovered[5]!.ended!.ending._tag, "Done")
        assert.equal(lastTextOf(recovered[5]), "RECOVERED")
        assert.equal(
          test.events.filter((event) => Predicate.isTagged(event, "TurnEnded")).length,
          6,
        )
      }),
    ),
  { timeout: 60000 },
)

it.live(
  "OpenCode settles requests and refuses expired answers or a deleted conversation",
  () =>
    check(
      Effect.gen(function* () {
        const test = yield* fixture("requests", {
          reply: (input) => {
            if (input.messages.at(-1)?.role === "tool") return [{ text: "Request settled." }]

            if (lastUserText(input).startsWith("Ask a question"))
              return [
                {
                  toolCall: {
                    id: "question-call",
                    name: "question",
                    arguments: {
                      questions: [
                        {
                          header: "Choose",
                          question: "Which color?",
                          options: [
                            { label: "Blue", description: "Blue color" },
                            { label: "Red", description: "Red color" },
                          ],
                          multiple: true,
                          custom: lastUserText(input).includes("free text"),
                        },
                      ],
                    },
                  },
                },
              ]

            return [
              {
                toolCall: {
                  id: "permission-call",
                  name: "bash",
                  arguments: { command: "echo PERMISSION_OK", description: "Echo a marker" },
                },
              },
            ]
          },
        })

        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const agent = yield* test.open("request-conversation").pipe(Scope.provide(scope))
        yield* agent.send("Ask permission")
        const permission = yield* test.request
        assert.isTrue(Predicate.isTagged(permission, "PermissionRequest"))
        yield* agent.answer(permission.requestId, AllowRequest.make({}))
        const allowed = yield* test.until(settled(1))
        assert.isTrue(
          allowed[0]!.parts.some(
            (part) => Predicate.isTagged(part, "PermissionRequest") && part.status === "allowed",
          ),
        )
        yield* agent.send("Deny permission")
        const denied = yield* test.request
        yield* agent.answer(denied.requestId, DenyRequest.make({ reason: "Don't run it" }))
        yield* test.until(settled(2))
        yield* agent.send("Ask a question")
        const question = yield* test.request
        assert.isTrue(Predicate.isTagged(question, "Question"))
        yield* agent.answer(
          question.requestId,
          AnswerQuestion.make({ answers: [{ chosen: ["Blue", "Red"], text: null }] }),
        )
        const answered = yield* test.until(settled(3))
        assert.isTrue(
          answered[2]!.parts.some(
            (part) => Predicate.isTagged(part, "Question") && part.status === "answered",
          ),
        )
        yield* agent.send("Ask a question with free text")
        const free = yield* test.request
        yield* agent.answer(
          free.requestId,
          AnswerQuestion.make({ answers: [{ chosen: [], text: "Green" }] }),
        )
        const freeAnswered = yield* test.until(settled(4))
        const freePart = freeAnswered[3]!.parts.find((part) => Predicate.isTagged(part, "Question"))
        assert.isTrue(
          Predicate.isTagged(freePart, "Question") && freePart.answers?.[0]?.text === "Green",
        )
        yield* agent.send("Ask permission")
        const request = yield* test.request
        yield* agent.session.stopTurn
        const stopped = yield* test.until(settled(5))
        assert.isTrue(
          stopped[4]!.parts.some(
            (part) => Predicate.isTagged(part, "PermissionRequest") && part.status === "expired",
          ),
        )

        const expired = yield* agent
          .answer(request.requestId, AllowRequest.make({}))
          .pipe(Effect.flip)

        assert.equal(expired._tag, "RequestNotWaiting")
        const client = test.tape.clients[0]!

        const sessions = yield* Effect.promise(() =>
          client.session.list({ search: "Glass request-conversation" }, { throwOnError: true }),
        )

        yield* Effect.promise(() =>
          client.session.delete({ sessionID: sessions.data[0]!.id }, { throwOnError: true }),
        )
        yield* Scope.close(scope, Exit.void)
        const failure = yield* test.open("request-conversation").pipe(Effect.flip)
        assert.include(failure.message, "conversation is missing or unreachable")
        assert.equal(
          test.events.filter((event) => Predicate.isTagged(event, "TurnEnded")).length,
          5,
        )
      }),
    ),
  { timeout: 60000 },
)

it.live(
  "OpenCode steers and stops tools, returning undelivered input even after a lost abort",
  () =>
    check(
      Effect.gen(function* () {
        const test = yield* fixture("steer-stop", {
          reply: (input) => {
            if (input.messages.at(-1)?.role === "tool") return [{ text: "Tool finished." }]

            if (lastUserText(input).startsWith("Hold"))
              return [
                {
                  toolCall: {
                    id: "gate-call",
                    name: "bash",
                    arguments: {
                      command: "node gate.cjs",
                      description: "Wait on the filesystem gate",
                    },
                  },
                },
              ]

            return [{ text: `Reply to ${lastUserText(input)}` }]
          },
        })

        yield* Effect.promise(() =>
          writeFile(
            join(test.folder, "gate.cjs"),
            `const fs = require("node:fs"); const path = require("node:path"); const gate = path.join(process.cwd(), "release"); const done = () => { if (fs.existsSync(gate)) { watcher.close(); process.stdout.write("GATE_OK"); } }; const watcher = fs.watch(process.cwd(), done); done();`,
          ),
        )
        const agent = yield* test.open("steer-conversation")
        yield* agent.configure({ permissionMode: "bypassPermissions" })
        yield* agent.send("Hold for a Steer")
        yield* test.until(runningTool("bash"))
        yield* agent.steer("Change the response")
        yield* Effect.promise(() => writeFile(join(test.folder, "release"), "go"))
        const steered = yield* test.until(settled(1))
        assert.isTrue(
          steered[0]!.parts.some(
            (part) => Predicate.isTagged(part, "Steer") && part.message === "Change the response",
          ),
        )
        yield* Effect.promise(() => unlink(join(test.folder, "release")))
        yield* agent.send("Hold for Stop")
        yield* test.until(runningTool("bash"))
        yield* agent.steer("Keep this if not consumed")
        const returned = yield* agent.session.stopTurn
        const stopped = yield* test.until(settled(2))
        assert.equal(stopped[1]!.ended!.ending._tag, "Stopped")
        assert.deepStrictEqual(
          returned?.map(({ message }) => message),
          ["Keep this if not consumed"],
        )
        yield* agent.send("Fresh after Stop")
        const fresh = yield* test.until(settled(3))
        assert.equal(lastTextOf(fresh.at(-1)), "Reply to Fresh after Stop")

        if (recordingSessions)
          assert.isFalse(
            test.provider.calls
              .at(-1)!
              .messages.some(({ content }) => content === "Keep this if not consumed"),
          )
        assert.equal(
          test.events.filter((event) => Predicate.isTagged(event, "TurnEnded")).length,
          3,
        )
        yield* agent.send("Hold for an uncertain abort")
        yield* test.until(runningTool("bash"))
        yield* agent.steer("RETURN_AFTER_LOST_ABORT")
        yield* test.tape.dropAbortRequest
        const left = yield* agent.session.stopTurn
        assert.deepStrictEqual(
          left?.map(({ message }) => message),
          ["RETURN_AFTER_LOST_ABORT"],
        )
        const abortStopped = yield* test.until(settled(4))
        assert.equal(abortStopped[3]!.ended!.ending._tag, "Stopped")
        yield* test.tape.started(2)
        yield* test.provider.configure({ output: "AFTER_ABORT_FAILURE" })
        yield* agent.send("Continue after uncertain abort")
        const afterAbort = yield* test.until(settled(5))
        assert.equal(lastTextOf(afterAbort[4]), "AFTER_ABORT_FAILURE")

        if (recordingSessions)
          assert.isFalse(
            test.provider.calls
              .at(-1)!
              .messages.some(({ content }) => content === "RETURN_AFTER_LOST_ABORT"),
          )
      }),
    ),
  { timeout: 60000 },
)

const pixel = {
  mediaType: "image/png" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
}

it.live(
  "OpenCode delivers images, context, Commands, selected skills, and subtask continuations",
  () =>
    check(
      Effect.gen(function* () {
        vi.stubEnv(
          "OPENCODE_CONFIG_CONTENT",
          JSON.stringify({
            command: { delegate: { template: "CHILD_SUBTASK", agent: "general", subtask: true } },
          }),
        )

        const test = yield* fixture("inputs", {
          output: (input) =>
            lastUserText(input) === "CHILD_SUBTASK"
              ? "CHILD_RESULT"
              : lastUserText(input).includes("Summarize the task tool output")
                ? "SUBTASK_CONTINUED"
                : "Inputs received.",
        })

        const skill = join(test.folder, "sent-skills", "selected-greeting")
        yield* Effect.promise(async () => {
          await mkdir(skill, { recursive: true })
          await writeFile(
            join(skill, "SKILL.md"),
            "---\nname: selected-greeting\ndescription: A selected greeting skill\n---\nSay GLASS_SKILL_OK.",
          )
        })

        const commands = yield* test.adapter.commands(test.folder, [
          { plugin: test.folder, skills: [skill] },
        ])

        assert.isTrue(commands.some(({ name }) => name === "selected-greeting"))

        const agent = yield* test.open("inputs-conversation", undefined, [
          { plugin: test.folder, skills: [skill] },
        ])

        const nativeSkills = yield* Effect.promise(() =>
          test.tape.clients.at(-1)!.app.skills({}, { throwOnError: true }),
        )

        assert.isTrue(nativeSkills.data.some(({ name }) => name === "selected-greeting"))
        yield* agent.send(
          "Here is a pixel",
          [pixel],
          "Use this resolved Mention: CONTEXT_MARKER.\n<glass_feedback>FEEDBACK_MARKER</glass_feedback>",
        )
        yield* test.until(settled(1))
        yield* agent.send("/greet")
        yield* test.until(settled(2))
        yield* agent.send("/selected-greeting")
        const done = yield* test.until(settled(3))
        assert.equal(lastTextOf(done.at(-1)), "Inputs received.")

        if (recordingSessions) {
          assert.isTrue(
            test.provider.calls.some((input) => lastUserText(input).includes("GLASS_SKILL_OK")),
          )
          assert.isTrue(
            test.provider.calls.some(
              (input) =>
                lastUserText(input).includes("CONTEXT_MARKER") &&
                lastUserText(input).includes("FEEDBACK_MARKER"),
            ),
          )
          assert.isTrue(
            test.provider.calls.some(({ messages }) =>
              messages.some(
                ({ content }) =>
                  Array.isArray(content) &&
                  content.some(
                    ({ image_url }) => image_url?.url === `data:image/png;base64,${pixel.data}`,
                  ),
              ),
            ),
          )
        }

        yield* agent.configure({ permissionMode: "bypassPermissions" })
        yield* agent.send("/delegate")
        const delegated = yield* test.until(settled(4))
        assert.equal(delegated[3]!.ended!.ending._tag, "Done")
        assert.equal(lastTextOf(delegated[3]), "SUBTASK_CONTINUED")
        assert.isTrue(
          delegated[3]!.parts.some(
            (part) =>
              Predicate.isTagged(part, "ToolCall") &&
              part.name === "task" &&
              part.output?.includes("CHILD_RESULT"),
          ),
        )
      }),
    ),
  { timeout: 60000 },
)

it.live(
  "OpenCode reports an unavailable default before an assistant exists",
  () =>
    check(
      Effect.gen(function* () {
        const test = yield* fixture("missing-model", { output: "not used" }, "glass-test/missing")
        const agent = yield* test.open("missing-model")
        yield* agent.send("Use the missing default")
        const failed = yield* test.until(settled(1))
        const ending = failed[0]!.ended!.ending
        assert.equal(ending._tag, "Failed")

        if (Predicate.isTagged(ending, "Failed")) {
          assert.include(ending.reason, "model")
          assert.notInclude(ending.reason, "\n")
        }

        yield* agent.configure({ model: "glass-test/gpt-test" })
        yield* agent.send("Recover with an available model")
        const recovered = yield* test.until(settled(2))
        assert.equal(recovered[1]!.ended!.ending._tag, "Done")
      }),
    ),
  { timeout: 60000 },
)

it.live(
  "OpenCode stops prompts and Commands during admission and accepts fresh Turns",
  () =>
    check(
      Effect.gen(function* () {
        const test = yield* fixture("admission-stop", { hang: true })
        const agent = yield* test.open("admission-stop")
        yield* agent.send("Stop this immediately")
        yield* agent.session.stopTurn
        const stopped = yield* test.until(settled(1))
        assert.equal(stopped[0]!.ended!.ending._tag, "Stopped")

        const status = yield* Effect.promise(() =>
          test.tape.clients[0]!.session.status({}, { throwOnError: true }),
        )

        assert.isFalse(Object.values(status.data).some(({ type }) => type !== "idle"))
        yield* test.provider.configure({ output: "ADMISSION_STOPPED" })
        yield* agent.send("Fresh after immediate Stop")
        const done = yield* test.until(settled(2))
        assert.equal(lastTextOf(done[1]), "ADMISSION_STOPPED")
        yield* test.provider.configure({ hang: true })
        yield* agent.send("/greet")
        yield* agent.session.stopTurn
        const commandStopped = yield* test.until(settled(3))
        assert.equal(commandStopped[2]!.ended!.ending._tag, "Stopped")
        yield* test.provider.configure({ output: "COMMAND_STOPPED" })
        yield* agent.send("Fresh after the Command")
        const afterCommand = yield* test.until(settled(4))
        assert.equal(lastTextOf(afterCommand[3]), "COMMAND_STOPPED")
      }),
    ),
  { timeout: 60000 },
)

it.live(
  "OpenCode routes subagent Permissions and applies bypass to their asks",
  () =>
    check(
      Effect.gen(function* () {
        vi.stubEnv(
          "OPENCODE_CONFIG_CONTENT",
          JSON.stringify({ agent: { general: { permission: { question: "allow" } } } }),
        )

        const test = yield* fixture("subagent-requests", {
          reply: (input) => {
            if (input.messages.at(-1)?.role === "tool") return [{ text: "SUBAGENT_DONE" }]

            if (lastUserText(input).includes("PARENT"))
              return [
                {
                  toolCall: {
                    id: "task-call",
                    name: "task",
                    arguments: {
                      description: "Child request",
                      prompt: lastUserText(input).includes("question")
                        ? "CHILD question"
                        : "CHILD run echo",
                      subagent_type: "general",
                    },
                  },
                },
              ]

            if (lastUserText(input).includes("CHILD question"))
              return [
                {
                  toolCall: {
                    id: "child-question",
                    name: "question",
                    arguments: {
                      questions: [
                        {
                          header: "Child",
                          question: "Which child answer?",
                          options: [{ label: "Blue", description: "Blue" }],
                        },
                      ],
                    },
                  },
                },
              ]

            if (lastUserText(input).includes("CHILD"))
              return [
                {
                  toolCall: {
                    id: "child-bash",
                    name: "bash",
                    arguments: { command: "echo CHILD_OK", description: "Child marker" },
                  },
                },
              ]

            return [{ text: "Title" }]
          },
        })

        const agent = yield* test.open("subagent-requests")
        yield* agent.send("PARENT delegate with default permissions")
        const permission = yield* test.request
        assert.equal(permission._tag, "PermissionRequest")
        yield* agent.answer(permission.requestId, AllowRequest.make({}))
        const allowed = yield* test.until(settled(1))
        assert.equal(lastTextOf(allowed[0]), "SUBAGENT_DONE")
        yield* agent.configure({ permissionMode: "bypassPermissions" })
        yield* agent.send("PARENT delegate with bypass")
        const bypassed = yield* test.until(settled(2))
        assert.equal(lastTextOf(bypassed[1]), "SUBAGENT_DONE")
        assert.isFalse(
          bypassed[1]!.parts.some((part) => Predicate.isTagged(part, "PermissionRequest")),
        )
        yield* agent.send("PARENT ask a child question")
        const question = yield* test.request
        assert.equal(question._tag, "Question")
        yield* agent.answer(
          question.requestId,
          AnswerQuestion.make({ answers: [{ chosen: [], text: "Green" }] }),
        )
        const answered = yield* test.until(settled(3))
        assert.equal(lastTextOf(answered[2]), "SUBAGENT_DONE")
      }),
    ),
  { timeout: 60000 },
)

it.live(
  "OpenCode reconciles a Turn that completes across a lost native event stream",
  () =>
    check(
      Effect.gen(function* () {
        const test = yield* fixture("reconnect", {
          reply: (input) =>
            input.messages.at(-1)?.role === "tool"
              ? [{ text: "Reconciled once." }]
              : [
                  {
                    toolCall: {
                      id: "reconnect-call",
                      name: "bash",
                      arguments: { command: "node gate.cjs", description: "Wait for reconnect" },
                    },
                  },
                ],
        })

        yield* Effect.promise(() =>
          writeFile(
            join(test.folder, "gate.cjs"),
            `const fs = require("node:fs"); const done = () => { if (fs.existsSync("release")) { watcher.close(); console.log("RECONNECT_OK"); } }; const watcher = fs.watch(process.cwd(), done); done();`,
          ),
        )
        const agent = yield* test.open("reconnect-conversation")
        yield* agent.configure({ permissionMode: "bypassPermissions" })

        for (let count = 1; count <= 3; count++) {
          yield* agent.send("Use a gated tool")
          yield* test.until(runningTool("bash"))
          yield* test.tape.disconnect
          yield* Effect.promise(() => writeFile(join(test.folder, "release"), "go"))
          const done = yield* test.until(settled(count))
          assert.equal(lastTextOf(done.at(-1)), "Reconciled once.")
          yield* Effect.promise(() => unlink(join(test.folder, "release")))
        }

        assert.equal(
          test.events.filter((event) => Predicate.isTagged(event, "TurnEnded")).length,
          3,
        )
      }),
    ),
  { timeout: 60000 },
)

it.live(
  "OpenCode recovers native crashes and fails cleanly when reconnection is exhausted",
  () =>
    check(
      Effect.gen(function* () {
        const test = yield* fixture("native-crash", {
          reply: (input) =>
            lastUserText(input) === "Hold during crash"
              ? [
                  {
                    toolCall: {
                      id: "crash-tool",
                      name: "bash",
                      arguments: { command: "node gate.cjs", description: "Wait for a crash" },
                    },
                  },
                ]
              : [{ text: `AFTER_NATIVE_RESTART ${lastUserText(input)}` }],
        })

        yield* Effect.promise(() =>
          writeFile(
            join(test.folder, "gate.cjs"),
            `require("node:fs").watch(process.cwd(), () => {});`,
          ),
        )
        const agent = yield* test.open("native-crash")
        yield* agent.configure({ permissionMode: "bypassPermissions" })
        yield* agent.send("Hold during crash")
        yield* test.until(runningTool("bash"))
        yield* test.tape.crash
        const failed = yield* test.until(settled(1))
        assert.equal(failed[0]!.ended!.ending._tag, "Failed")
        yield* agent.send("Continue the same conversation after restart")
        const resumed = yield* test.until(settled(2))
        assert.equal(
          lastTextOf(resumed[1]),
          "AFTER_NATIVE_RESTART Continue the same conversation after restart",
        )

        if (recordingSessions)
          assert.isTrue(
            test.provider.calls
              .at(-1)!
              .messages.some(({ content }) => content === "Hold during crash"),
          )
        yield* agent.send("THIRD_TURN")
        const third = yield* test.until(settled(3))
        assert.equal(lastTextOf(third[2]), "AFTER_NATIVE_RESTART THIRD_TURN")
        yield* test.provider.configure({
          reply: () => [
            {
              toolCall: {
                id: "recovery-tool",
                name: "bash",
                arguments: { command: "node gate.cjs", description: "Wait for disconnect" },
              },
            },
          ],
        })
        yield* agent.send("Wait for a lost stream")
        yield* test.until(runningTool("bash"))
        yield* test.tape.failSubscriptions
        yield* test.tape.disconnect
        const disconnected = yield* test.until(settled(4))
        assert.equal(disconnected[3]!.ended!.ending._tag, "Failed")
        yield* agent.session.closed
        assert.isTrue(yield* agent.session.stopped)
      }),
    ),
  { timeout: 60000 },
)

it.live(
  "OpenCode keeps concurrent Agents in separate native conversations while Commands load",
  () =>
    check(
      Effect.gen(function* () {
        const test = yield* fixture("concurrent", {
          output: (input) => `Reply to ${lastUserText(input)}`,
        })

        const [first, second] = yield* Effect.all(
          [
            test.open("first-concurrent"),
            test.open("second-concurrent"),
            test.adapter.commands(test.folder, []),
          ],
          { concurrency: "unbounded" },
        )

        const [one, two] = yield* Effect.all(
          [first.send("FIRST_AGENT"), second.send("SECOND_AGENT")],
          { concurrency: "unbounded" },
        )

        const done = yield* test.until(settled(2))
        assert.equal(lastTextOf(done.find(({ id }) => id === one)), "Reply to FIRST_AGENT")
        assert.equal(lastTextOf(done.find(({ id }) => id === two)), "Reply to SECOND_AGENT")
        assert.equal(
          test.events.filter((event) => Predicate.isTagged(event, "TurnEnded")).length,
          2,
        )
      }),
    ),
  { timeout: 60000 },
)

const smallContext = () =>
  vi.stubEnv(
    "OPENCODE_CONFIG_CONTENT",
    JSON.stringify({
      provider: {
        "glass-test": { models: { "gpt-test": { limit: { context: 8000, output: 1000 } } } },
      },
    }),
  )

const compactionModel = (): FakeModelSettings => {
  let used = false

  return {
    tokens: (input) => {
      if (!used && lastUserText(input) === "BIG_USAGE" && (input.tools?.length ?? 0) > 0) {
        used = true

        return 20000
      }

      return 50
    },
    output: (input) =>
      lastUserText(input) === "BIG_USAGE"
        ? "BEFORE_COMPACTION"
        : lastUserText(input).includes("Continue if you have next steps")
          ? "AFTER_COMPACTION"
          : "COMPACTION_SUMMARY",
  }
}

it.live(
  "OpenCode keeps compaction continuations inside their Turn, including after a model switch",
  () =>
    check(
      Effect.gen(function* () {
        smallContext()
        const test = yield* fixture("compaction", compactionModel())
        const agent = yield* test.open("compaction")
        yield* agent.send("BIG_USAGE")
        const done = yield* test.until(settled(1))
        assert.equal(done[0]!.ended!.ending._tag, "Done")
        assert.equal(lastTextOf(done[0]), "AFTER_COMPACTION")
        assert.isTrue(
          done[0]!.parts.some(
            (part) => Predicate.isTagged(part, "Text") && part.text === "BEFORE_COMPACTION",
          ),
        )
        assert.equal(
          test.events.filter((event) => Predicate.isTagged(event, "TurnEnded")).length,
          1,
        )

        if (recordingSessions)
          assert.isTrue(
            test.provider.calls.some((input) =>
              lastUserText(input).includes("Continue if you have next steps"),
            ),
          )
        yield* test.provider.configure(compactionModel())
        const switched = yield* test.open("compaction-switch")
        yield* switched.configure({ model: "glass-test/gpt-test-thinking" })
        yield* switched.send("BIG_USAGE")
        yield* test.until(settled(2))
        yield* switched.configure({ model: "glass-test/gpt-test" })
        yield* switched.send("Smaller context now")
        const switchedTurns = yield* test.until(settled(3))
        assert.equal(
          switchedTurns[2]!.ended!.ending._tag,
          "Done",
          JSON.stringify(switchedTurns[2]!.ended),
        )
        assert.equal(lastTextOf(switchedTurns[2]), "AFTER_COMPACTION")
      }),
    ),
  { timeout: 60000 },
)

it.live(
  "OpenCode reconciles more than 100 native messages using opaque page cursors",
  () =>
    check(
      Effect.gen(function* () {
        vi.stubEnv("OPENCODE_CONFIG_CONTENT", JSON.stringify({ snapshot: false }))
        let steps = 0

        const test = yield* fixture("pagination", {
          reply: (input) => {
            if ((input.tools?.length ?? 0) === 0) return [{ text: "Title" }]

            if (steps++ < 105)
              return [
                {
                  toolCall: {
                    id: `page-${steps}`,
                    name: "read",
                    arguments: { filePath: "proof.txt" },
                  },
                },
              ]

            return [{ text: "PAGINATION_DONE" }]
          },
        })

        yield* Effect.promise(() => writeFile(join(test.folder, "proof.txt"), "Read a marker."))
        const agent = yield* test.open("pagination")
        yield* agent.configure({ permissionMode: "bypassPermissions" })
        yield* agent.send("Read the marker through all the steps")
        const done = yield* test.until(settled(1))
        assert.equal(done[0]!.ended!.ending._tag, "Done", JSON.stringify(done[0]!.ended))
        assert.equal(lastTextOf(done[0]), "PAGINATION_DONE")
        assert.equal(
          done[0]!.parts.filter(
            (part) => Predicate.isTagged(part, "ToolCall") && part.status === "done",
          ).length,
          105,
        )
      }),
    ),
  { timeout: 60000 },
)
