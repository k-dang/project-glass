import {
  AgentHarness,
  applyTranscriptUpdate,
  emptyTranscript,
  type Turn,
  type TurnPart,
} from "@glass/contracts"
import { DateTime, Effect, Match, Predicate, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { HostEvent } from "../src/agentHost/protocol"
import { Transcripts } from "../src/Transcripts"
import { DEMO_REPOSITORY } from "./demoPullRequests"
import { REPLAYED_PREFIX } from "./replayedNames"

/** What `drive` in `adapterSessions.ts` writes to `GLASS_TRANSCRIPTS_DIR` when a session ends. */
export const ReplayedTranscript = Schema.fromJsonString(
  Schema.Struct({ harness: AgentHarness, events: Schema.Array(HostEvent) }),
)

const decodeTranscript = Schema.decodeUnknownSync(ReplayedTranscript)

const withTurnIds = (scenario: string, events: ReadonlyArray<HostEvent>) =>
  events.map((event) =>
    Predicate.isTagged(event, "AgentStatusesChanged")
      ? event
      : { ...event, turnId: `${scenario}:${event.turnId}` },
  )

const partStates = (part: TurnPart): ReadonlyArray<string> =>
  Match.valueTags(part, {
    Text: () => ["Text"],
    Thinking: () => ["Thinking"],
    Steer: () => ["Steer"],
    ToolCall: ({ status, parentToolCallId }) => [
      `ToolCall ${status}`,
      ...(parentToolCallId === null ? [] : ["nested ToolCall"]),
    ],
    PermissionRequest: ({ status }) => [`PermissionRequest ${status}`],
    Question: ({ status }) => [`Question ${status}`],
  })

const turnStates = (turn: Turn): ReadonlyArray<string> => [
  turn.ended === null ? "Turn running" : `Turn ${turn.ended.ending._tag}`,
  ...(turn.images.length > 0 ? ["images"] : []),
  ...turn.parts.flatMap(partStates),
]

const uiStates = (events: ReadonlyArray<HostEvent>) => {
  const { turns, agentStatuses, backgroundToolCalls } = events.reduce(
    applyTranscriptUpdate,
    emptyTranscript,
  )

  return new Set([
    ...turns.flatMap(turnStates),
    ...(agentStatuses.length > 0 ? ["agent statuses"] : []),
    ...(backgroundToolCalls.length > 0 ? ["background tool calls"] : []),
  ])
}

interface Replayed {
  readonly scenario: string
  readonly harness: AgentHarness
  readonly events: ReadonlyArray<HostEvent>
  readonly states: ReadonlySet<string>
}

const distinct = (replays: ReadonlyArray<Replayed>) => {
  const shown = new Set<string>()

  return replays
    .toSorted((a, b) => b.states.size - a.states.size || a.scenario.localeCompare(b.scenario))
    .filter(({ harness, states }) => {
      const fresh = [...states].flatMap((state) => {
        const key = `${harness} ${state}`

        return shown.has(key) ? [] : [key]
      })

      for (const state of fresh) shown.add(state)

      return fresh.length > 0
    })
}

/**
 * Stores, as Conversations, the transcripts the recorded harness sessions produced on replay
 * (`GLASS_TRANSCRIPTS_DIR` in `adapterSessions.ts`), one for each distinct set of UI states.
 */
export const seedReplayedConversations = (directory: string, folder: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const transcripts = yield* Transcripts
    const createdAt = DateTime.formatIso(yield* DateTime.now)

    const replays = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((file) => {
        const { harness, events } = decodeTranscript(readFileSync(join(directory, file), "utf8"))

        return { scenario: basename(file, ".json"), harness, events, states: uiStates(events) }
      })

    for (const { scenario, harness, events } of distinct(replays)) {
      const id = randomUUID()
      yield* sql`INSERT INTO conversation ${sql.insert({
        id,
        name: `${REPLAYED_PREFIX}${harness}/${scenario}`,
        owner: DEMO_REPOSITORY.owner,
        repo: DEMO_REPOSITORY.repo,
        base_branch: "main",
        harness,
        folder,
        created_at: createdAt,
      })}`
      yield* transcripts.save(id, withTurnIds(scenario, events))
    }
  })
