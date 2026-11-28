---
name: verify-update-delivery
description: Model-check how a Thread or the Global chat is sent Updates - only when idle, each Event once, none lost, giving up after three in a row, three at a time, across a Glass restart, an Update to the Global chat delivered again after one - and how told started work is marked seen (subscription.delivered_through, updates_in_a_row, after_message, retries_delivery, RUN_AT_ONCE, GIVES_UP_AFTER, turn_seen_at). Use when a change touches Updates, updateDelivery, deliver or follow in Subscriptions, EventLog.after, GlassSource, lastMessageTurn, lastEndedUpdate, runningUpdates, startedByMessage or startIfIdle in Transcripts, or thread_turn.unprompted.
---

# Verify Update delivery

A subscriber, a Thread or the Global chat, is sent an Update when the Event log has Events about a Subscription's subject past its cursor (`delivered_through`) and at least one is of a kind it asked for. The Update carries every such Event, and the cursor moves past them in the transaction that starts the Turn. Each Subscription also keeps how many Updates in a row it got (`updates_in_a_row`) and the last Turn a message reached when it got the last one (`after_message`). An Update to the Global chat retries delivery (`retries_delivery`), so a restart delivers it again rather than ending it. Once a Turn ends, Glass marks the started work its subscriber's last Update told seen.

Two models check this:

- [`model/Updates.tla`](model/Updates.tla) models two subscribers, one of them the Global chat, each with one Subscription, and checks every order of Events, decisions, messages, Steers, Turns the Agent harness starts by itself, Turn endings, and one Glass restart.
- [`seen-marks/SeenMarks.tla`](seen-marks/SeenMarks.tla) models one subscriber told about started work, and checks every order of Events, Updates that reach the agent or fail, other Turns, a restart, and Glass marking told work seen.

## The rules

| Rule | In plain words | Harm if broken |
| --- | --- | --- |
| `NeverCutsIn` | An Update starts only when the subscriber has no Turn running and no Queued message. | An Update cuts into your Turn or goes ahead of your Queued message. |
| `ToldOnce` | No Event goes into two Updates. | The agent is put to work twice on the same Event, such as one Thread finishing. |
| `NoneLost` | The cursor never passes an Event of a kind the Subscription asked for without telling it, also while the subscriber waits its turn or has given up. | A failure, a review, or finished work the subscriber was to hear about is never told. |
| `RunsAtMostTheLimit` | No more Updates run at once than the limit, also after a restart. | A broken base branch starts every subscribed Thread together. |
| `StopsAtTheLimit` | A Subscription gets no more Updates in a row than the limit, unless a message reached the subscriber in between. | A fix that keeps failing, or the Global chat and a Thread it started waking each other, runs forever. |
| `MessageLetsItTryAgain` | Once a message reaches a subscriber, the Updates before it no longer count. | A subscriber that gave up stays stuck after you tell it what to do. |
| `GlobalChatUpdatesSurviveRestart` | A restart never ends an Update to the Global chat; it is delivered again. | The Global chat's pi can't outlive the backend, so its Update would end after its cursor moved, and its Events would be lost. |
| `WaitingStaysUnseen` | Telling that a started Thread waits on the user doesn't mark it seen. | You lose the unseen mark on a Thread whose agent only said it needs you. |
| `SeenOnlyOnceHeard` | Glass marks told work seen only once an Update carrying it reached the agent. | Nobody acts on finished work: the agent never heard it and your unseen mark is gone. |

## Run

```sh
node tools/tla/tlc.ts .agents/skills/verify-update-delivery/model/Updates.tla --mutants
node tools/tla/tlc.ts .agents/skills/verify-update-delivery/seen-marks/SeenMarks.tla --mutants
```

Expect `Result: ok` from each: every rule holds and every mutant is caught. The first takes about thirty seconds, the second a few. [`tools/tla/README.md`](../../../tools/tla/README.md) explains the output. Read a counterexample, or chart the model, with the `/statechart` skill.

## Coverage

Synced with the code at commit `759ca168`. Before you trust a result, run `git diff 759ca168 -- <files below>`. If a covered function changed, compare it with its actions first.

| Model | Code |
| --- | --- |
| `RecordEvent` in both | `EventLog.record` in `apps/server/src/EventLog.ts`, fed by `eventsBetween` in `apps/server/src/gitHubEvents.ts`, the ended lookups in `apps/server/src/GitHubSource.ts`, and `report` in `apps/server/src/GlassSource.ts` |
| `Decide` | One `whenIdleFor` transaction in `sendUpdate` in `apps/server/src/Updates.ts`; `whenIdle` in `apps/server/src/ThreadTurns.ts` and `apps/server/src/GlobalChat.ts`; `idle` in `apps/server/src/Transcripts.ts` |
| `Pending`, `Wakes`, `Count(t) >= GivesUpAfter` | `pendingFor`, `tells` and `gaveUp` in `apps/server/src/updateDelivery.ts`, over `EventLog.after` |
| `DecideQuiet` | `delivered` in `updateDelivery.ts` for the Subscriptions that tell nothing, recorded with `deliver` in `apps/server/src/Subscriptions.ts`; a Subscription that gave up keeps its Events until a message reaches the subscriber |
| `SlotFree` | `runningUpdates` in `Transcripts.ts`, counted in `sendUpdate` against `RUN_AT_ONCE` |
| `StartUpdate` in both | `startIfIdle` in `Transcripts.ts`, with `deliver` in the same transaction |
| `afterNewMessage`, `MessageReaches` | `lastMessageTurn` in `Transcripts.ts`, which reads the Turns a message started (no context or a viewing context, and not `unprompted`) and the Turns with a Steer, against `after_message`; for the Global chat it reads the current Session |
| `SendMessage`, `QueueMessage`, `QueuedMessageStarts`, `TurnEnds`, `StoppedQueueStarts` | `stepThread` in `apps/server/src/threadState.ts` |
| `Steer` | The Steer part the Agent harness reports, which `lastMessageTurn` reads |
| `HarnessStartsTurn` | `TurnStarted` from the Agent harness in `writeApplied` in `Transcripts.ts`, saved with `unprompted = 1` |
| `GlassRestarts` in `Updates.tla` | Nothing but the wait order lives in memory (`waiting` in `Updates.ts`). A local Thread's Turn is interrupted in `serve` in `ThreadTurns.ts`; a Sandbox Thread's Turn keeps running; an Update with `retriesDelivery`, which `sendUpdate` sets for the Global chat, is sent again by `retryDeliveries` in `Transcripts.ts` and recovered in `apps/server/src/agentHost/piRedelivery.ts` |
| `EndTurn` in `SeenMarks.tla` | How a Turn ends: see the `verify-turn-lifecycle` skill. `settleUndelivered` in `Transcripts.ts` fails an Update that never reached the agent |
| `MarkTold` | `markToldBy` and `toldIn` in `GlassSource.ts`, reading `lastEndedUpdate` in `Transcripts.ts` after each `subscribeEnded`; `markSeen` in `Transcripts.ts` and `markIncludedInStartedWorkUpdate` in `apps/server/src/AgentReviews.ts` |

Each mutant in `model/mutants.json` and `seen-marks/mutants.json` is one way to break this code: skipping the idle check, moving the cursor after the Turn starts, moving it past waking Events while the subscriber waits its turn or has given up, ignoring the limit or counting running Updates in memory, never counting, counting a Turn the Agent harness started as a message, keeping the count in memory, ignoring messages, not retrying the Global chat's Update, marking a waiting Thread seen, marking after an Update that failed, and marking from the Update still running.

## When a change touches this code

1. Find the actions for each covered function you changed, and make them do what the code now does. One SQL transaction in the code is one action in the model.
2. Run both commands. A rule that newly breaks is either a bug in the change or a model that no longer matches the code. Replay the path in the code. If the code can't take a step, fix the model. If it can, report the path in the code's words. Don't weaken a rule to make it pass.
3. When you find a bug the code ships with, record it in that model's `findings.json` and in a Finding section here. When it is fixed, the runner prints `NOW HOLDS`: remove it from both, and add a mutant to that model's `mutants.json` that brings the bug back, so the rule is still shown to fail.
4. When the models match the code, move the sync commit above to the commit you checked.

## Scope

`Updates.tla` bounds: 2 subscribers, the Global chat one of them, 1 Update at once (the code runs 3), giving up after 2 (the code gives up after 3), 3 Events per Subscription, 2 messages, Steers or harness Turns, 1 restart. `SeenMarks.tla` bounds: 1 subscriber, 3 Events, 2 other Turns, 1 restart.

Left out: which Events a read of the mirror records (tested in `apps/server/src/Events.test.ts`), which Events the glass Source records (tested in `apps/server/src/GlassSource.test.ts`), the order in which waiting subscribers start (tested in `apps/server/src/Updates.test.ts`), what the Inbox shows, a Subscription ending on its PR merging or closing or its Agent review ending, several Subscriptions in one Update, and a canceled Queued message.
