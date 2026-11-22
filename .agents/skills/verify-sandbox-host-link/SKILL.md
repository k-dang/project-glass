---
name: verify-sandbox-host-link
description: Model-check how Glass follows a Sandbox's agent host across dropped connections, new hosts, host replacement, and Glass restarts (HostLink position, turnOnLostHost and takenTurn, Ready.replacingHost, journal_host, journal_turn). Use when a change touches follow, connect, followFrom, placeLostTurn, the connection release, whileOpen, takeTurn, replaceHost, or how Sandbox Threads resume in apps/server/src/Sandboxes.ts.
---

# Verify the Sandbox host link

For each Sandbox Thread, `Sandboxes` keeps a `HostLink` with three mutable fields: `position`, the host whose journal it follows; `turnOnLostHost`, the Turn that was running when Glass last lost a host; and `takenTurn`, the last Turn a followed host accepted. `position` and `takenTurn` are saved on the Thread (`journal_host`, `journal_turn`), so they survive a relaunch. The persisted `Ready.replacingHost` flag says a host replacement is under way. When Glass follows a host and has a lost Turn, `placeLostTurn` asks the host whether it still has it, and otherwise ends it: as Cut off if a host took it, and as Interrupted if none did. [`model/SandboxHostLink.tla`](model/SandboxHostLink.tla) models one Sandbox Thread, its agent host, the connection, and Glass restarts.

## The rules

| Rule | In plain words | Harm if broken |
| --- | --- | --- |
| `DownHostGetsReplaced` | While a replacement has stopped the old host and not started the new one, Glass still knows it must replace it. | After a quit mid-replacement, Glass retries a host that no longer exists, and the Thread stays unreachable. |
| `LostHostTurnsEnd` | Once Glass follows a new host, no Turn that ran on an old host shows as running, unless its delivery call is still waiting to fail. | The Thread shows "running" forever and every message only queues. |
| `RunningTurnIsOnFollowedHost` | While Glass follows a host, its running Turn is on that host, has its end in the journal, or is being delivered. | Same as above. |
| `CutOffTurnsRan` | A Turn cut off because the host changed had run on the old host. | Your message says "Glass lost the agent while it worked" though no agent ever saw it. |
| `RanTurnsEndCutOff` | A lost Turn that ran on a host ends as Cut off, not as Interrupted or as an undelivered message. | A Turn whose host went away says "Interrupted when Glass quit" or "Try again", though an agent worked on it. |

## Finding (current code)

`RanTurnsEndCutOff` breaks when a host goes away between accepting a Turn and Glass saving that it did:

1. You send a message. The agent host accepts `StartTurn` and starts the agent.
2. Before Glass records the acceptance, one of these happens:
   - The Sandbox gets a new agent host while the reply is in flight. The pending `StartTurn` fails, and `deliver` ends the Turn as an undelivered message ("Glass lost the process that runs Threads. Try again.").
   - Glass quits before the reply arrives, or before `takeTurn` writes `journal_turn`. On relaunch onto a new host, `placeLostTurn` finds no saved acceptance and ends the Turn as Interrupted.

Either way the agent did work on the old host, but the Turn doesn't end as Cut off. Glass can't tell "the host accepted it, but the reply was lost" from "it never arrived", so a fix would need evidence from the old host, such as a journal entry for the Turn that Glass already saved.

## Run

```sh
node tools/tla/tlc.ts .agents/skills/verify-sandbox-host-link/model/SandboxHostLink.tla --mutants
```

Expect `Result: ok`: every rule but `RanTurnsEndCutOff` holds, `RanTurnsEndCutOff` still breaks as the finding above, and every other mutant is caught (`TakenForgottenOnRestart` is skipped while its rule is a finding). [`tools/tla/README.md`](../../../tools/tla/README.md) explains the output. Read a counterexample, or chart the model, with the `/statechart` skill.

## Coverage

Synced with the code at commit `36004428a70b36b190ceba163543adec7771e062`. Before you trust a result, run `git diff 36004428 -- <files below>`. If a covered function changed, compare it with its actions first.

| Model | Code (`apps/server/src/Sandboxes.ts` unless named) |
| --- | --- |
| `YouSendMessage`, `DeliveryFails` | `deliver`, `dispatch` and `settleUndelivered` in `apps/server/src/ThreadTurns.ts`, waiting on `connect`; `whileOpen` in the `connected` client in `follow` |
| `HostTakesTurn` | The agent host accepting `StartTurn` (`apps/server/src/agentHost/handlers.ts`) |
| `GlassGetsAcceptance`, `GlassSavesTaken` | The `connected` client's `StartTurn` reply, then `takeTurn` (`link.takenTurn`, then the `journal_turn` update) |
| `AgentEndsTurn`, `GlassSavesJournal` | `followJournal` in `apps/server/src/hostJournal.ts`; `save` in `apps/server/src/Transcripts.ts` |
| `Release`, `ConnectionDrops` | The `acquireRelease` release in `follow` that closes the `connected` client and sets `link.turnOnLostHost` |
| `SandboxRestartsHost` | The provider restarting the agent host; any new `greet` host id |
| `GlassFindsOtherProtocol`, `GlassStopsOldHost`, `GlassStartsNewHost` | `replacingIfIncompatible`, `afterReplacing`, `updateReady` with `replacingHost`; `replaceHost` in `apps/server/src/sandboxCalls.ts` |
| `GlassFollowsHost`, `Carried`, `EndsLost`, `EndsAsCutOff` | `connection` in `follow` (`greet`, clearing `replacingHost`, `placeLostTurn` with `UnacknowledgedTurns`, `followFrom`) |
| `GlassCutsOffLostHost` | `change` publishing to `lost`; `serve` (the `lost` stream) in `ThreadTurns.ts` |
| `GlassRestarts` | The `links` built from `stored` (`journal_host`, `journal_turn`, `runningTurn`); `resume`; `interrupted` in `apps/server/src/Threads.ts` |

## When a change touches this code

1. Find the actions for each covered function you changed, and make them do what the code now does. A section under `connectLock` or `recordLock`, or one SQL statement, is one action in the model.
2. Run the command. A rule that newly breaks is either a bug in the change or a model that no longer matches the code. Replay the path in the code. If the code can't take a step, fix the model. If it can, report the path in the code's words. Don't weaken a rule to make it pass.
3. When you find a bug the code ships with, record it in `model/findings.json` and in a Finding section here. When it is fixed, the runner prints `NOW HOLDS`: remove it from both, and add a mutant to `model/mutants.json` that brings the bug back, so the rule is still shown to fail.
4. When the model matches the code, move the sync commit above to the commit you checked.

## Scope

Bounds: 3 Turns, 3 agent hosts, one Sandbox Thread. Left out: the `Recovery` phases and their timing (see `apps/server/src/reconnecting.ts` and its tests), `Building` and `Gone` records, lease extension, Stop, and Turns that retry delivery (only the Global chat sets that, and it runs on this device). The model assumes a delivery call on a dropped connection fails rather than hangs. That holds because a closed socket fails pending calls with an `RpcClientError`, and `whileOpen` turns the interruption of a call Glass dropped itself into that same failure. A Turn running when migration `0025_journal_turn` ran has no saved `journal_turn`, so it ends as Interrupted if its host changes.
