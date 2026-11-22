---
name: verify-started-work-updates
description: Model-check how the Global chat or a Thread hears about the Threads it started (started_thread, started_work_update_outcome_at, started_work_update_turn_id, turn_seen_at). Use when a change touches StartedWork, StartedWorkUpdates, or how Started work update Turns are sent, recorded, or reconciled.
---

# Verify Started work updates

When the Global chat or a Thread starts a Thread, Glass later sends the starter a Started work update Turn with that Thread's outcome. Three columns of `started_thread` (`started_at`, `started_work_update_outcome_at`, `started_work_update_turn_id`) and the started Thread's `turn_seen_at` encode where each outcome is. Glass marks a started Thread seen only once its update Turn has ended and didn't fail, so a failed update leaves the Thread unseen. [`model/StartedWorkUpdates.tla`](model/StartedWorkUpdates.tla) models one starter and one started Thread, and checks every order of outcomes, updates, reconciles, and your visits.

## The rules

| Rule | In plain words | Harm if broken |
| --- | --- | --- |
| `ReportedOnce` | No outcome goes into two Started work updates. | The agent hears the same Thread finished twice and acts on it twice. |
| `WaitingStaysUnseen` | Reporting that a Thread is waiting doesn't mark the Thread seen. | You lose the unseen mark on a Thread whose agent only said it needs you. |
| `FinishedWorkReachesSomeone` | A finished or failed outcome reaches the starter's agent, or you saw it, or the Thread stays unseen, or its update is still pending. | Nobody acts on the outcome: the agent never heard it and your unseen mark is gone. |

## Run

```sh
node tools/tla/tlc.ts .agents/skills/verify-started-work-updates/model/StartedWorkUpdates.tla --mutants
```

Expect `Result: ok`: every rule holds and every mutant is caught. [`tools/tla/README.md`](../../../tools/tla/README.md) explains the output. Read a counterexample, or chart the model, with the `/statechart` skill.

## Coverage

Synced with the code at commit `36004428a70b36b190ceba163543adec7771e062`. Before you trust a result, run `git diff 36004428 -- <files below>`. If a covered function changed, compare it with its actions first.

| Model | Code |
| --- | --- |
| `StartedThreadReachesOutcome` | `pendingOutcomes` in `apps/server/src/StartedWork.ts` (the waiting, ended, and Stopped cases), fed by `lastEnds` and `waitingNow` in `apps/server/src/Transcripts.ts` |
| `IsNew` | `ifNew` in `StartedWork.ts` |
| `StarterSendsUpdate` | `sendUpdateOnce` in `apps/server/src/StartedWorkUpdates.ts`; `recordStartedWorkUpdate` in `StartedWork.ts`; `whenIdle` in `apps/server/src/GlobalChat.ts` and `apps/server/src/ThreadTurns.ts` |
| `Reconcile` | `reconcileStartedWorkUpdates` in `StartedWork.ts` (skips an update Turn that hasn't ended or ended Failed); `markSeen` in `Transcripts.ts` |
| `UpdateReachesAgent`, `UpdateTurnFails` | How a Turn ends: see the `verify-turn-lifecycle` skill |
| `YouOpenStartedThread` | `markSeen` from the renderer when you open a Thread |

## When a change touches this code

1. Find the actions for each covered function you changed, and make them do what the code now does. One SQL transaction in the code is one action in the model.
2. Run the command. A rule that newly breaks is either a bug in the change or a model that no longer matches the code. Replay the path in the code. If the code can't take a step, fix the model. If it can, report the path in the code's words. Don't weaken a rule to make it pass.
3. When you find a bug the code ships with, record it in `model/findings.json` and in a Finding section here. When it is fixed, the runner prints `NOW HOLDS`: remove it from both, and add a mutant to `model/mutants.json` that brings the bug back, so the rule is still shown to fail.
4. When the model matches the code, move the sync commit above to the commit you checked.

## Scope

Bounds: 4 outcomes, one starter, one started Thread. Left out: Agent reviews (`started_agent_review`, whose re-start resets the columns, and `markIncludedInStartedWorkUpdate`; reconcile treats them the same way), several started Threads in one update, Stopped endings (never reported), host clock skew between `ended.at` and `started_at`, and removed Threads. A failed update doesn't resend its outcomes; the unseen mark is how they still reach you.
