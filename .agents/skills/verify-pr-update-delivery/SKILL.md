---
name: verify-pr-update-delivery
description: Model-check how a subscribed Thread is sent PR updates - only when idle, once per state of the PR, giving up after three, three at a time, across a Glass restart (subscription.last_told, RUN_AT_ONCE, GIVES_UP_AFTER). Use when a change touches PullRequestUpdates, subscriptionDecisions, pullRequestUpdateDecision, recordTold or toldAbout in Subscriptions, lastMessageTurn, runningPullRequestUpdates or startIfIdle in Transcripts, or the sender stepThread gives a Turn in threadState.
---

# Verify PR update delivery

A Thread with a Subscription to a PR is sent a PR update when the PR has something new for it. Glass decides what to send from the PR's state in the mirror and the Subscription's `last_told`, which holds what the Thread was last told, how many PR updates in a row each reason got, and the last Turn a message of yours reached when that was written. The decision and the Turn's start are one transaction per Thread, run only while the Thread is idle. [`model/PullRequestUpdates.tla`](model/PullRequestUpdates.tla) models two Threads, each subscribed to its own PR for failing checks, and checks every order of check results, decisions, your messages, other agents' messages, Turn endings, and one Glass restart.

## The rules

| Rule | In plain words | Harm if broken |
| --- | --- | --- |
| `NeverCutsIn` | A PR update starts only in a Thread with no Turn running and no Queued message. | A PR update cuts into your Turn or goes ahead of your Queued message. |
| `ToldOnce` | A Thread is never sent two PR updates about the same state of a PR. | The agent is put to work twice on a state it already couldn't change. |
| `TellsWhatIsStillTrue` | A PR update carries the PR's state at the moment it starts, also after waiting its turn. | The agent is asked to fix what is already fixed. |
| `RunsAtMostTheLimit` | No more PR updates run at once than the limit, also after a restart. | A broken base branch starts every subscribed Thread together. |
| `StopsAtTheLimit` | A reason gets no more PR updates in a row than the limit, unless it cleared or your message reached the Thread in between. | A fix that keeps failing runs forever. |
| `MessageLetsItTryAgain` | Once your message reaches a Thread, the PR updates before it no longer count. | A Thread that gave up stays stuck after you tell it what to do. |

## Run

```sh
node tools/tla/tlc.ts .agents/skills/verify-pr-update-delivery/model/PullRequestUpdates.tla --mutants
```

Expect `Result: ok`: every rule holds and every mutant is caught. A run takes about two minutes. [`tools/tla/README.md`](../../../tools/tla/README.md) explains the output. Read a counterexample, or chart the model, with the `/statechart` skill.

## Coverage

Synced with the code at commit `a124dcd51a7207a80138ff78c2578386b32fa633`. Before you trust a result, run `git diff a124dcd5 -- <files below>`. If a covered function changed, compare it with its actions first.

| Model | Code |
| --- | --- |
| `ChecksFail`, `ChecksRunAgain`, `NewPushHasNoChecksYet`, `ChecksPass` | What a read of the PR mirror shows: `subscribedNow` in `apps/server/src/GitHubSource.ts`, which gives the sender nothing until one refresh since Glass started has read both the PR's repository and the PR's details |
| `Decide` | One `threads.whenIdle` transaction in `sendUpdate` in `apps/server/src/Updates.ts`, which asks each Source what holds, decides in `sourceOf` in `apps/server/src/Source.ts`, and plans what to record in `toRecord`; `whenIdle` in `apps/server/src/ThreadTurns.ts`; `idle` in `apps/server/src/Transcripts.ts` |
| `IsNew`, `DecideNothingHolds`, `Count(t) < GivesUpAfter` | `decide` in `apps/server/src/updateDecision.ts` and `failingChecks` in `apps/server/src/pullRequestNow.ts` (`cleared` returns the count to zero; `unsettled` keeps it, both while checks run again and while a new push has none yet) |
| `SlotFree` | `runningUpdates` in `Transcripts.ts`, counted in `sendUpdate` in `Updates.ts` against `RUN_AT_ONCE` |
| `StartUpdate` | `startIfIdle` in `Transcripts.ts`, with `recordTold` in `apps/server/src/Subscriptions.ts` in the same transaction |
| `afterNewMessage`, `MessageReaches` | `lastMessageTurn` in `Transcripts.ts`, which reads the Turns your message started (`started_by = 'user'`) and your Steers, against `afterMessage` in `last_told`; `toldBefore` and `countedAfresh` in `updateDecision.ts` |
| `YouSendMessage`, `YouQueueMessage`, `AgentSendsMessage`, `AgentQueuesMessage`, `QueuedMessageStarts`, `TurnEnds`, `StoppedQueueStarts` | `stepThread` in `apps/server/src/threadState.ts`, which gives the Turn a message starts that message's sender |
| `AgentMessageReaches` | A Turn another agent's message started (`started_by` is `creator` or `agent`), which `lastMessageTurn` leaves out |
| `YouSteer` | The Steer part the Agent harness reports, which `lastMessageTurn` reads |
| `GlassRestarts` | Nothing but the wait order lives in memory (`waiting` in `Updates.ts`). A local Thread's Turn is interrupted in `serve` in `ThreadTurns.ts`; a Sandbox Thread's Turn keeps running |

Each mutant in `model/mutants.json` is one way to break this code: skipping the idle check, saving `last_told` after the Turn starts, sending what was decided before the wait, ignoring the limit or counting running PR updates in memory, never counting, resetting the count while checks run again or while a new push has no checks yet, counting another agent's message as yours, keeping the count in memory, and ignoring your messages.

## When a change touches this code

1. Find the actions for each covered function you changed, and make them do what the code now does. One SQL transaction in the code is one action in the model.
2. Run the command. A rule that newly breaks is either a bug in the change or a model that no longer matches the code. Replay the path in the code. If the code can't take a step, fix the model. If it can, report the path in the code's words. Don't weaken a rule to make it pass.
3. When you find a bug the code ships with, record it in `model/findings.json` and in a Finding section here. When it is fixed, the runner prints `NOW HOLDS`: remove it from both, and add a mutant to `model/mutants.json` that brings the bug back, so the rule is still shown to fail.
4. When the model matches the code, move the sync commit above to the commit you checked.

## Scope

Bounds: 2 Threads, 1 PR update at once (the code runs 3), giving up after 2 (the code gives up after 3), 3 failing states per PR, 2 messages (yours or another agent's), 1 restart. Each Thread has one Subscription covering failing checks; review feedback, requested changes and a merge conflict go through the same steps in `decide`.

Left out: the order in which waiting Threads start (tested in `apps/server/src/PullRequestUpdateLimits.test.ts`), what the Inbox shows, the PR update about a PR merging or closing, several Subscriptions in one PR update, a canceled Queued message, and a failure GitHub reports again unchanged after reporting none.

`StopsAtTheLimit` is the only promise about the count's size. Glass reads the count's resets at a decision, so a reason that clears and returns between two decisions (while the Thread is busy or waits its turn) keeps its count, and the Thread can give up one PR update early.
