---
name: verify-update-delivery
description: Model-check how a subscribed Thread is sent Updates - only when idle, each Event once, none lost, giving up after three in a row, three at a time, across a Glass restart (subscription.delivered_through, updates_in_a_row, after_message, RUN_AT_ONCE, GIVES_UP_AFTER). Use when a change touches Updates, updateDelivery, deliver in Subscriptions, EventLog.after, lastMessageTurn, runningUpdates, startedByMessage or startIfIdle in Transcripts, or thread_turn.unprompted.
---

# Verify Update delivery

A Thread with a Subscription is sent an Update when the Event log has Events about its subject past the Subscription's cursor (`delivered_through`) and at least one is of a kind it asked for. The Update carries every such Event, and the cursor moves past them in the transaction that starts the Turn. Each Subscription also keeps how many Updates in a row it got (`updates_in_a_row`) and the last Turn a message reached when it got the last one (`after_message`). [`model/Updates.tla`](model/Updates.tla) models two Threads, each with one Subscription, and checks every order of Events, decisions, messages, Steers, Turns the Agent harness starts by itself, Turn endings, and one Glass restart.

## The rules

| Rule | In plain words | Harm if broken |
| --- | --- | --- |
| `NeverCutsIn` | An Update starts only in a Thread with no Turn running and no Queued message. | An Update cuts into your Turn or goes ahead of your Queued message. |
| `ToldOnce` | No Event goes into two Updates. | The agent is put to work twice on the same Event. |
| `NoneLost` | The cursor never passes an Event of a kind the Subscription asked for without telling it, also while the Thread waits its turn or has given up. | A failure or a review the Thread was asked to handle is never told. |
| `RunsAtMostTheLimit` | No more Updates run at once than the limit, also after a restart. | A broken base branch starts every subscribed Thread together. |
| `StopsAtTheLimit` | A Subscription gets no more Updates in a row than the limit, unless a message reached the Thread in between. | A fix that keeps failing runs forever. |
| `MessageLetsItTryAgain` | Once a message reaches a Thread, the Updates before it no longer count. | A Thread that gave up stays stuck after you tell it what to do. |

## Run

```sh
node tools/tla/tlc.ts .agents/skills/verify-update-delivery/model/Updates.tla --mutants
```

Expect `Result: ok`: every rule holds and every mutant is caught. A run takes about ten seconds. [`tools/tla/README.md`](../../../tools/tla/README.md) explains the output. Read a counterexample, or chart the model, with the `/statechart` skill.

## Coverage

Synced with the code at commit `d9e1af6b`. Before you trust a result, run `git diff d9e1af6b -- <files below>`. If a covered function changed, compare it with its actions first.

| Model | Code |
| --- | --- |
| `RecordEvent` | `EventLog.record` in `apps/server/src/EventLog.ts`, fed by `eventsBetween` in `apps/server/src/gitHubEvents.ts` and the ended lookups in `apps/server/src/GitHubSource.ts` |
| `Decide` | One `threads.whenIdle` transaction in `sendUpdate` in `apps/server/src/Updates.ts`; `whenIdle` in `apps/server/src/ThreadTurns.ts`; `idle` in `apps/server/src/Transcripts.ts` |
| `Pending`, `Wakes`, `Count(t) >= GivesUpAfter` | `pendingFor`, `tells` and `gaveUp` in `apps/server/src/updateDelivery.ts`, over `EventLog.after` |
| `DecideQuiet` | `delivered` in `updateDelivery.ts` for the Subscriptions that tell nothing, recorded with `deliver` in `apps/server/src/Subscriptions.ts`; a Subscription that gave up keeps its Events until a message reaches the Thread |
| `SlotFree` | `runningUpdates` in `Transcripts.ts`, counted in `sendUpdate` against `RUN_AT_ONCE` |
| `StartUpdate` | `startIfIdle` in `Transcripts.ts`, with `deliver` in the same transaction |
| `afterNewMessage`, `MessageReaches` | `lastMessageTurn` in `Transcripts.ts`, which reads the Turns a message started (no context or a viewing context, and not `unprompted`) and the Turns with a Steer, against `after_message` |
| `SendMessage`, `QueueMessage`, `QueuedMessageStarts`, `TurnEnds`, `StoppedQueueStarts` | `stepThread` in `apps/server/src/threadState.ts` |
| `Steer` | The Steer part the Agent harness reports, which `lastMessageTurn` reads |
| `HarnessStartsTurn` | `TurnStarted` from the Agent harness in `writeApplied` in `Transcripts.ts`, saved with `unprompted = 1` |
| `GlassRestarts` | Nothing but the wait order lives in memory (`waiting` in `Updates.ts`). A local Thread's Turn is interrupted in `serve` in `ThreadTurns.ts`; a Sandbox Thread's Turn keeps running |

Each mutant in `model/mutants.json` is one way to break this code: skipping the idle check, moving the cursor after the Turn starts, moving it past waking Events while the Thread waits its turn or has given up, ignoring the limit or counting running Updates in memory, never counting, counting a Turn the Agent harness started as a message, keeping the count in memory, and ignoring messages.

## When a change touches this code

1. Find the actions for each covered function you changed, and make them do what the code now does. One SQL transaction in the code is one action in the model.
2. Run the command. A rule that newly breaks is either a bug in the change or a model that no longer matches the code. Replay the path in the code. If the code can't take a step, fix the model. If it can, report the path in the code's words. Don't weaken a rule to make it pass.
3. When you find a bug the code ships with, record it in `model/findings.json` and in a Finding section here. When it is fixed, the runner prints `NOW HOLDS`: remove it from both, and add a mutant to `model/mutants.json` that brings the bug back, so the rule is still shown to fail.
4. When the model matches the code, move the sync commit above to the commit you checked.

## Scope

Bounds: 2 Threads, 1 Update at once (the code runs 3), giving up after 2 (the code gives up after 3), 3 Events per Subscription, 2 messages, Steers or harness Turns, 1 restart.

Left out: which Events a read of the mirror records (tested in `apps/server/src/Events.test.ts`), the order in which waiting Threads start (tested in `apps/server/src/Updates.test.ts`), what the Inbox shows, a Subscription ending on its PR merging or closing, several Subscriptions in one Update, and a canceled Queued message.
