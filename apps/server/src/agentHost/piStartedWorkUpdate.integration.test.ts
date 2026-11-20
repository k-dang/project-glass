import { SessionManager } from "@earendil-works/pi-coding-agent"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { ConversationOutcome, TextPart, StartedWorkUpdate } from "@glass/contracts"
import { Deferred, Effect, Exit, Predicate, Schema, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import { bundledPi } from "../../test/demoConversation"
import { fakeModelProvider, lastUserText } from "../../test/fakeModelProvider"
import { isolatedHome, stubHome } from "../../test/harness"
import { piAdapter } from "./piAdapter"
import { startedWorkUpdateDelivery, SessionEntries } from "./piStartedWorkUpdate"
import { type HostEvent, WorkRole } from "./protocol"

const sent = {
  message: "",
  images: [],
  prompt: "Started work update the completed work.",
  context: StartedWorkUpdate.make({
    work: [
      ConversationOutcome.make({
        conversationId: "started",
        name: "Started",
        outcome: "finished",
        reason: null,
        askedWith: "Build it",
      }),
    ],
  }),
}

const fixture = Effect.gen(function* () {
  const home = yield* isolatedHome
  const model = yield* fakeModelProvider(home, { output: "The work finished. Want to review it?" })
  stubHome(home)
  vi.stubEnv("PI_OFFLINE", "1")
  const adapter = yield* piAdapter(bundledPi)

  const open = (conversation: string) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const ended = yield* Deferred.make<void>()
      const events: Array<HostEvent> = []

      const session = yield* adapter
        .start({
          folder: home,
          conversation,
          role: WorkRole.make({}),
          glassTools: undefined,
          skills: [],
          report: (event) =>
            Effect.sync(() => events.push(event)).pipe(
              Effect.andThen(
                Predicate.isTagged(event, "TurnEnded")
                  ? Deferred.succeed(ended, undefined)
                  : Effect.void,
              ),
            ),
        })
        .pipe(Scope.provide(scope))

      return { session, events, ended: Deferred.await(ended), close: Scope.close(scope, Exit.void) }
    })

  return { home, model, open }
})

for (const stopReason of ["error", "length"] as const)
  it(`continues a Started work update whose ${stopReason} attempt pi omitted for recovery`, () => {
    const saved = SessionManager.inMemory()

    const pending = startedWorkUpdateDelivery("started-work-update-1", sent.prompt, {
      entries: [],
      leafId: null,
    })

    if (pending.state !== "pending") assert.fail("Expected a pending Started work update")
    saved.appendMessage({ role: "user", content: pending.prompt, timestamp: 1 })

    const reply = {
      role: "assistant" as const,
      api: "openai-completions",
      provider: "glass-test",
      model: "gpt-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }

    const toolCall = { id: "call-1", name: "read", arguments: { path: "notes.md" } }
    saved.appendMessage({
      ...reply,
      content: [{ type: "toolCall", ...toolCall }],
      stopReason: "toolUse",
      timestamp: 2,
    })
    saved.appendMessage({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Notes" }],
      isError: false,
      timestamp: 3,
    })

    const failed = saved.appendMessage({
      ...reply,
      content: [],
      stopReason,
      errorMessage: stopReason === "error" ? "Rate limit" : "",
      timestamp: 4,
    })

    saved.appendContextEdit(failed, null)

    if (stopReason === "length")
      saved.appendCompaction("Earlier context summarized", failed, 100_000)

    const delivery = startedWorkUpdateDelivery(
      "started-work-update-1",
      sent.prompt,
      Schema.decodeUnknownSync(SessionEntries)({
        entries: saved.getEntries(),
        leafId: saved.getLeafId(),
      }),
    )

    assert.equal(delivery.state, "responding")
    assert.deepInclude(delivery.events, {
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", toolCall },
    })
    assert.deepInclude(delivery.events, {
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      result: { content: [{ type: "text", text: "Notes" }] },
      isError: false,
    })
    assert.isFalse(
      delivery.events.some(
        (event) => event.type === "message_end" && event.message.stopReason === stopReason,
      ),
    )
  })

it.live(
  "restores pi's saved Started work update response into the same Turn without another model request",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const conversation = randomUUID()
      const first = yield* f.open(conversation)
      yield* first.session.startTurn("started-work-update-1", sent)
      yield* first.ended
      yield* first.close

      const restored = yield* f.open(conversation)
      yield* restored.session.startTurn("started-work-update-1", {
        ...sent,
        prompt: "The instructions changed after an upgrade.",
      })
      yield* restored.ended

      assert.lengthOf(f.model.calls, 1)
      const output = restored.events.findLast((event) => Predicate.isTagged(event, "PartSet"))
      assert.deepInclude(output, {
        part: TextPart.make({ text: "The work finished. Want to review it?" }),
      })
      assert.deepInclude(restored.events.at(-1), { turnId: "started-work-update-1" })
    }).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
  "finishes and restores an accepted Started work update without repeating its original input",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const saved = SessionManager.create(f.home)

      const pending = startedWorkUpdateDelivery("started-work-update-1", sent.prompt, {
        entries: [],
        leafId: null,
      })

      if (pending.state !== "pending") assert.fail("Expected a pending Started work update")
      saved.appendMessage({ role: "user", content: pending.prompt, timestamp: 1 })

      const restored = yield* f.open(saved.getSessionId())
      yield* restored.session.startTurn("started-work-update-1", sent)
      yield* restored.ended

      assert.lengthOf(f.model.calls, 1)
      assert.include(lastUserText(f.model.calls[0]!), "Finish that Started work update")
      const branch = SessionManager.open(saved.getSessionFile()!).getBranch()

      const users = branch.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
      )

      assert.lengthOf(users, 2)
      assert.equal(users[0]?.content, pending.prompt)

      yield* restored.close
      const completed = yield* f.open(saved.getSessionId())
      yield* completed.session.startTurn("started-work-update-1", sent)
      yield* completed.ended
      assert.lengthOf(f.model.calls, 1)
    }).pipe(Effect.provide(NodeServices.layer)),
)

it.live(
  "keeps a Started work update unfinished when pi's prompt response is invalid and the process exits",
  () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const command = join(home, "pi-invalid-response.mjs")
      writeFileSync(
        command,
        String.raw`
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).on('line', (line) => {
        const command = JSON.parse(line);
        const data =
          command.type === 'prompt' ? null
          : command.type === 'get_entries' ? { entries: [], leafId: null }
          : { isStreaming: false, isCompacting: false };
        process.stdout.write(JSON.stringify({ type: 'response', id: command.id, success: true, data }) + "\n", () => {
          if (command.type === 'prompt') process.exit(0);
        });
      });
    `,
      )
      const adapter = yield* piAdapter(command)
      const events: Array<HostEvent> = []

      const session = yield* adapter.start({
        folder: home,
        conversation: randomUUID(),
        role: WorkRole.make({}),
        glassTools: undefined,
        skills: [],
        report: (event) =>
          Effect.sync(() => {
            events.push(event)
          }),
      })

      const error = yield* Effect.flip(session.startTurn("started-work-update-transport", sent))

      assert.equal(
        error.message,
        "Couldn't confirm pi's Started work update delivery. Restart Glass to try again.",
      )
      yield* session.closed
      assert.isFalse(events.some(Predicate.isTagged("TurnEnded")))
    }).pipe(Effect.provide(NodeServices.layer)),
)
