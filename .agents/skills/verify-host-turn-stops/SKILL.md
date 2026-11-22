---
name: verify-host-turn-stops
description: Model-check how the agent host stops a Claude Code Turn, from you or over the journal budget, and what happens to its steers (overBudgetStop in HostThreads, stopping and steers in turnLoop, interruptAll in claudeAdapter). Use when a change touches HostThreads report or stopTurn, turnLoop stop, steer or dropSteer, claudeAdapter stopTurn or steer, claudeTurn onResult, Exited or takeIn, or ThreadTurns stop or trySteer.
---

# Verify how the agent host stops a Turn

The agent host stops a running Turn when you press stop, or on its own when the journal is over budget. `HostThreads` keeps the over-budget stop in a mutable `let overBudgetStop`. Once a Turn is stopping, `turnLoop` refuses new steers, so Glass queues them. A stop asks Claude Code to interrupt, and its receipt lists the steers Claude Code cancelled. The host hands back those it still holds, and Glass queues them again, either right away for your stop or through `steersNotTakenIn` on the `TurnEnded` for an over-budget stop. When the Turn ends, by a result or by Claude Code exiting, it shows every steer it still holds. [`model/HostTurnStops.tla`](model/HostTurnStops.tla) models one Thread's Turns on the host, its steers, and both kinds of stop.

## The rules

| Rule | In plain words | Harm if broken |
| --- | --- | --- |
| `OneOverBudgetStopPerTurn` | The host sends at most one over-budget stop per Turn. | Several stops race, and their steers come back more than once. |
| `NoSteerTwice` | No steer is both shown in the Turn and queued again. | The agent gets the same message twice. |
| `ReturnedSteersComeBack` | Every steer a stop handed back is queued again once the Turn ends. | Your message disappears. |
| `NoSteerLost` | Every steer in a Turn is shown in it or queued again once the Turn ends. | Your message disappears from the transcript. |

## Run

```sh
node tools/tla/tlc.ts .agents/skills/verify-host-turn-stops/model/HostTurnStops.tla --mutants
```

Expect `Result: ok`: every rule holds and every mutant is caught. [`tools/tla/README.md`](../../../tools/tla/README.md) explains the output. Read a counterexample, or chart the model, with the `/statechart` skill.

## Coverage

Synced with the code at commit `36004428a70b36b190ceba163543adec7771e062`. Before you trust a result, run `git diff 36004428 -- <files below>`. If a covered function changed, compare it with its actions first.

| Model | Code |
| --- | --- |
| `AgentStartsTurn`, `AgentEndsTurn` | `begin` and `handle` in `apps/server/src/agentHost/turnLoop.ts`; `onResult`, `Exited` and `end` in `apps/server/src/agentHost/claudeTurn.ts`; `report` (clearing `overBudgetStop`) and `withSteersNotTakenIn` in `apps/server/src/agentHost/HostThreads.ts` |
| `YouSteer` | `trySteer` in `apps/server/src/ThreadTurns.ts`; `steer` in `turnLoop.ts` (refused while stopping) and `apps/server/src/agentHost/claudeAdapter.ts` |
| `AgentReadsSteer`, `AgentAnswersSteer` | Claude Code taking in a priority prompt; `takeIn` and `showSteers` in `claudeTurn.ts` |
| `Cancellable`, `YouStop`, `StopReceipt`, `Held` | `stopTurn` in `claudeAdapter.ts` (`interruptAll`, then `dropSteer` for each cancelled steer); `stop` and `dropSteer` in `turnLoop.ts`; `stop` and `prependQueued` in `ThreadTurns.ts` |
| `JournalFills`, `JournalDrains` | `append` and `acknowledge` in `apps/server/src/agentHost/Journal.ts` |
| `OverBudgetStop` | `report` in `HostThreads.ts` (the `full` check, `overBudgetStop`, the forked `stopTurn(..., overBudget)`) |

## When a change touches this code

1. Find the actions for each covered function you changed, and make them do what the code now does. One `Effect.sync` block in `turnLoop`, or one call to the Claude Code SDK, is one action in the model. Your stop and its receipt are two actions, because a result or an exit can land between them.
2. Run the command. A rule that newly breaks is either a bug in the change or a model that no longer matches the code. Replay the path in the code. If the code can't take a step, fix the model. If it can, report the path in the code's words. Don't weaken a rule to make it pass.
3. When you find a bug the code ships with, record it in `model/findings.json` and in a Finding section here. When it is fixed, the runner prints `NOW HOLDS`: remove it from both, and add a mutant to `model/mutants.json` that brings the bug back, so the rule is still shown to fail.
4. When the model matches the code, move the sync commit above to the commit you checked.

## Scope

Bounds: 2 Turns, 2 steers, one Thread. Covers Claude Code only: pi stops and steers through `piTurn.ts` and `piAdapter.ts`, which the model leaves out, though pi shares `turnLoop`'s refusal while stopping. The over-budget stop and its receipt are still one action. Also left out: late steers that start the next run (`lateSteerStartsNextRun`), background work, and the `running` map and `runningTurns` (`retire`, `unacknowledgedTurns`). When a result or an exit comes before a stop's receipt, the Turn shows the steers Claude Code is about to cancel instead of handing them back: nothing is lost or doubled, but the transcript shows a steer the agent never read.
