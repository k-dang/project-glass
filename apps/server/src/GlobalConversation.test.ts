import { assert, it } from "@effect/vitest"
import {
  AgentContext,
  applyTranscriptUpdate,
  type CapturedContext,
  emptyTranscript,
  GlobalConversationProgram,
  PullRequestContext,
  PullRequestRef,
  Revision,
  TextPart,
  type Transcript,
  type Turn,
  TurnDone,
  TurnInterrupted,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { agentsFixture, holding, lastText, settled } from "../test/agentsFixture"
import { childProcesses, startedHost } from "../test/agentHostProcesses"

type Client = Effect.Success<typeof agentsFixture>["client"]

const watchGlobal = (client: Client, until: (transcript: Transcript) => boolean) =>
  client.WatchGlobalTranscript().pipe(
    Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
    Stream.filter(until),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )

const globalTurns = (client: Client, until: (turns: ReadonlyArray<Turn>) => boolean) =>
  watchGlobal(client, ({ turns }) => until(turns)).pipe(Effect.map(({ turns }) => turns))

const send = (client: Client, message: string, context: CapturedContext | null = null) =>
  client.SendGlobalMessage({ message, images: [], context })

const onPullRequest = PullRequestContext.make({
  pullRequest: new PullRequestRef({ owner: "glass-demo", repo: "greeter", number: 7 }),
  revision: new Revision({ base: "b0", head: "h1" }),
})

it.live("answers a message with no Local checkout, making no worktree or branch", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture

    yield* send(f.client, "Say hello")
    const turns = yield* globalTurns(f.client, settled(1))

    assert.deepStrictEqual(turns[0]?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(lastText(turns[0]), TextPart.make({ text: "Reply to: Say hello" }))
    assert.isFalse(existsSync(join(f.home, ".project-glass", "worktrees")))
    assert.deepStrictEqual(yield* f.agents, [])
  }),
)

it.live("keeps each message's captured context with its Turn, including once it was queued", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const onAgent = AgentContext.make({ agentId: "agent-1", name: "agent/swift-otter" })

    yield* send(f.client, "hold:first", onPullRequest)
    yield* globalTurns(f.client, holding)
    yield* send(f.client, "Next", onAgent)
    const { queued } = yield* watchGlobal(f.client, (transcript) => transcript.queued.length === 1)

    assert.deepStrictEqual(queued[0]?.context, onAgent)

    const refused = yield* f.client
      .ChangeGlobalConversationProgram({ engine: "pi", model: null, effort: null })
      .pipe(Effect.flip)

    assert.equal(refused._tag, "AgentBusy")

    yield* f.release("first")
    const turns = yield* globalTurns(f.client, settled(2))

    assert.deepStrictEqual(
      turns.map(({ context }) => context),
      [onPullRequest, onAgent],
    )
  }),
)

it.live(
  "restores the transcript, Unsent message, and program after a relaunch, with the running Turn interrupted",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const program = { engine: "pi", model: "scripted", effort: null } as const
      const unsent = { message: "Still writing", images: [] }

      yield* f.client.ChangeGlobalConversationProgram(program)
      yield* send(f.client, "hold:never", onPullRequest)
      yield* globalTurns(f.client, holding)
      yield* f.client.SaveGlobalUnsentMessage(unsent)

      const restarted = yield* f.restart

      assert.deepStrictEqual(
        yield* restarted.GetGlobalConversationProgram(),
        new GlobalConversationProgram(program),
      )
      assert.deepStrictEqual(yield* restarted.GetGlobalUnsentMessage(), unsent)

      yield* send(restarted, "After")
      const turns = yield* globalTurns(restarted, settled(2))

      assert.deepStrictEqual(
        turns.map(({ ended }) => ended?.ending),
        [TurnInterrupted.make({}), TurnDone.make({})],
      )
      assert.deepStrictEqual(turns[0]?.context, onPullRequest)
      assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "Reply to: After" }))
    }),
)

const glassCalls = (turn: Turn | undefined) =>
  turn?.parts.flatMap((part) =>
    Predicate.isTagged(part, "ToolCall") ? [{ status: part.status, output: part.output }] : [],
  )

it.live(
  "gives each start of its program a fresh credential for Glass's tools, revoking the last",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      yield* f.client.AddToDo({ title: "Reply to Sam" })

      yield* send(f.client, "call:list_to_dos")
      const [read] = yield* globalTurns(f.client, settled(1))

      assert.deepStrictEqual(
        glassCalls(read)?.map(({ status }) => status),
        ["done"],
      )
      assert.include(glassCalls(read)?.[0]?.output, "Reply to Sam")

      yield* f.client.ChangeGlobalConversationProgram({ engine: "pi", model: null, effort: null })
      yield* send(f.client, "call-ended:list_to_dos")
      yield* send(f.client, "call:list_to_dos")
      const [, ended, restarted] = yield* globalTurns(f.client, settled(3))

      assert.deepStrictEqual(glassCalls(ended), [{ status: "failed", output: "Refused with 401" }])
      assert.deepStrictEqual(
        glassCalls(restarted)?.map(({ status }) => status),
        ["done"],
      )
    }),
)

it.live("revokes its program's credential when the agent host stops", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const earlierHosts = childProcesses(process.pid, "scriptedAgentHost.mjs")

    yield* send(f.client, "hold:never")
    yield* globalTurns(f.client, holding)

    const host = startedHost(earlierHosts)
    assert.isDefined(host, "the backend has no agent host running")
    process.kill(host, "SIGKILL")
    yield* globalTurns(f.client, settled(1))

    yield* send(f.client, "call-ended:list_to_dos")
    const [, ended] = yield* globalTurns(f.client, settled(2))

    assert.deepStrictEqual(glassCalls(ended), [{ status: "failed", output: "Refused with 401" }])
  }),
)
