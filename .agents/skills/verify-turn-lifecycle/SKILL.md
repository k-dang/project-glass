---
name: verify-turn-lifecycle
description: Model-check how a Thread's Turns start, end, and survive a lost or replaced agent host or a Glass restart (thread_turn.ended, retries_delivery). Use when a change touches how Transcripts, ThreadTurns, Sandboxes, or LocalAgentHost start, stop, cut off, interrupt, fail, or redeliver a Turn.
---

# Verify the Turn lifecycle

A Turn's ending lives in `thread_turn.ended` (null while it runs). The rules for changing it are spread over SQL `WHERE` clauses in `Transcripts` and the `retries_delivery` column, which a stop you ask for clears. [`model/TurnLifecycle.tla`](model/TurnLifecycle.tla) models one Thread's Turns, the agent host, its journal, and Glass's connection to it, and checks every order of those steps up to the bounds below.

## The rules

| Rule | In plain words | Harm if broken |
| --- | --- | --- |
| `OneRunningTurn` | A Thread has at most one running Turn. | `runningTurn` reads only the first row, so a second running Turn is never stopped or ended. |
| `NoPartsAfterFailure` | A Turn that failed gets no more parts. | A Turn shown as failed keeps growing with output from an agent Glass told to stop. |
| `RetriedTurnsSurviveLoss` | A Turn that retries delivery is never cut off or interrupted. | A Started work update is lost when the host goes away, and the Global chat never reports it. |
| `OrdinaryTurnsEnd` | A running Turn that doesn't retry delivery is always on the host, being delivered, or has its end waiting in the journal. | The Thread shows "running" forever and every message you send only queues. |
| `StoppedTurnsEnd` | A Turn you stopped is always on the host, being delivered, or has its end waiting in the journal. | The Turn you stopped stays running, or runs again after a restart. |
| `FinalEndingsStay` | Once a Turn is Done, Failed, Stopped, or Interrupted, its ending never changes. Only Cut off can be replaced. | The transcript and Started work outcomes change after the fact. |

## Run

```sh
node tools/tla/tlc.ts .agents/skills/verify-turn-lifecycle/model/TurnLifecycle.tla --mutants
```

Expect `Result: ok`: every rule holds and every mutant is caught. [`tools/tla/README.md`](../../../tools/tla/README.md) explains the output. Read a counterexample, or chart the model, with the `/statechart` skill. It retells each broken rule as its shortest path in plain words.

## Coverage

Synced with the code at commit `b204060a3653274172343636724f824fe6f69899`. Before you trust a result, run `git diff b204060a -- <files below>`. If a covered function changed, compare it with its actions first.

| Model | Code |
| --- | --- |
| `YouSend`, `YouSendQueued`, `GlobalChatStartsUpdate`, the queue start in `EndWith` | `stepThread` in `apps/server/src/threadState.ts`; `execute` in `apps/server/src/Transcripts.ts`; `startIfIdle` with `retriesDelivery` in `apps/server/src/StartedWorkUpdates.ts` |
| `Accepts`, `EndWith`, `GlassSavesJournal` | `writeApplied` (`TurnEnded`, `PartSet`, `PartAppended` and `writableTurn`) and `save` in `apps/server/src/Transcripts.ts` |
| `HostTakesTurn`, `HostRefusesTurn`, `DeliveryTimesOut` | `deliver`, `dispatch`, `settleUndelivered` in `apps/server/src/ThreadTurns.ts`; `settleUndelivered` in `Transcripts.ts`; `begin` in `apps/server/src/agentHost/turnLoop.ts` |
| `YouStop` | `stop` and `stopHost` in `ThreadTurns.ts`; `askedToStop` in `Transcripts.ts` (sets `retries_delivery = 0`); `stop` in `turnLoop.ts` |
| `CutOffRunning`, `GlassLosesHost`, `AgentHostReplaced` | `endUnfinished` in `Transcripts.ts`; `serve` (the `lost` stream) in `ThreadTurns.ts`; `placeLostTurn` in `apps/server/src/Sandboxes.ts`; `stop` in `apps/server/src/LocalAgentHost.ts` |
| `GlassRestarts`, `Carried` | `serve` in `ThreadTurns.ts`; `retryDeliveries` in `Transcripts.ts`; `carriedOn` and `glassStartedNoOtherTurn` in `LocalAgentHost.ts`; `unacknowledgedTurns` in `apps/server/src/agentHost/HostThreads.ts` |
| `AgentWritesPart`, `AgentEndsTurn` | The harness adapters' `report` into `Journal.append` (`apps/server/src/agentHost/`) |

## When a change touches this code

1. Find the actions for each covered function you changed, and make them do what the code now does. One SQL statement or one locked section in the code is one action in the model. If the change adds a new way to start, end, or redeliver a Turn, add an action.
2. Run the command. A rule that newly breaks is either a bug in the change or a model that no longer matches the code. Replay the path in the code, one action at a time. If the code can't take a step, fix the model. If it can, the change has a bug: report the path in the code's words. Don't weaken a rule to make it pass.
3. When you find a bug the code ships with, record it in `model/findings.json` and in a Finding section here. When it is fixed, the runner prints `NOW HOLDS`: remove it from both, and add a mutant to `model/mutants.json` that brings the bug back, so the rule is still shown to fail.
4. When the model matches the code, move the sync commit above to the commit you checked.

## Scope

Bounds: 3 Turns, 1 queued message, 2 journal entries waiting, one Thread, one agent host at a time. Treated as one step: a Transcripts transaction under the Thread's lock. Left out: Steers and their requeueing, part contents, Questions and Permission requests, several Threads sharing a host, and the Sandbox's `Gone` record. The `verify-sandbox-host-link` skill covers how a Sandbox Thread's lost Turn ends.
