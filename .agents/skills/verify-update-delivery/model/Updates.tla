-------------------------------- MODULE Updates --------------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Subscribers, Retries, RunAtOnce, GivesUpAfter, MaxEvents, MaxMessages, MaxRestarts, Broken

VARIABLES
    logged,
    wakes,
    cursor,
    count,
    afterNewMessage,
    turn,
    queued,
    unsaved,
    tracked,
    messages,
    restarts,
    told,
    toldTwice,
    lost,
    cutIn,
    dropped,
    streak,
    sinceMessage

vars == <<logged, wakes, cursor, count, afterNewMessage, turn, queued, unsaved, tracked,
          messages, restarts, told, toldTwice, lost, cutIn, dropped, streak, sinceMessage>>

log == <<logged, wakes>>
ghosts == <<told, toldTwice, lost, cutIn, dropped, streak, sinceMessage>>
bounds == <<messages, restarts>>

Mutant(name) == name \in Broken

Init ==
    /\ logged = [t \in Subscribers |-> 0]
    /\ wakes = [t \in Subscribers |-> {}]
    /\ cursor = [t \in Subscribers |-> 0]
    /\ count = [t \in Subscribers |-> 0]
    /\ afterNewMessage = [t \in Subscribers |-> FALSE]
    /\ turn = [t \in Subscribers |-> "idle"]
    /\ queued = [t \in Subscribers |-> FALSE]
    /\ unsaved = [t \in Subscribers |-> 0]
    /\ tracked = {}
    /\ messages = 0
    /\ restarts = 0
    /\ told = [t \in Subscribers |-> {}]
    /\ toldTwice = FALSE
    /\ lost = FALSE
    /\ cutIn = FALSE
    /\ dropped = FALSE
    /\ streak = [t \in Subscribers |-> 0]
    /\ sinceMessage = [t \in Subscribers |-> 0]

Idle(t) == turn[t] = "idle" /\ ~queued[t]

Running == {t \in Subscribers : turn[t] = "update"}

Count(t) == IF afterNewMessage[t] THEN 0 ELSE count[t]

Pending(t) == {e \in 1..logged[t] : e > cursor[t]}

Wakes(t) == Pending(t) \cap wakes[t] # {}

SlotFree ==
    \/ Mutant("IgnoreLimit")
    \/ Cardinality(IF Mutant("CountRunningInMemory") THEN tracked ELSE Running) < RunAtOnce

\* A read of the PR mirror records an Event, of a kind the Subscription asked for or not.
RecordEvent(t) ==
    /\ logged[t] < MaxEvents
    /\ logged' = [logged EXCEPT ![t] = @ + 1]
    /\ \/ wakes' = [wakes EXCEPT ![t] = @ \cup {logged[t] + 1}]
       \/ UNCHANGED wakes
    /\ UNCHANGED <<cursor, count, afterNewMessage, turn, queued, unsaved, tracked, bounds,
                   ghosts>>

\* Moving the cursor past Events without telling them.
PassOver(t) ==
    /\ cursor' = [cursor EXCEPT ![t] = logged[t]]
    /\ lost' = (lost \/ Wakes(t))
    /\ UNCHANGED <<log, count, afterNewMessage, turn, queued, unsaved, tracked, bounds, told,
                   toldTwice, cutIn, dropped, streak, sinceMessage>>

DecideQuiet(t) ==
    /\ Pending(t) # {}
    /\ ~Wakes(t)
    /\ PassOver(t)

DecidePassOverWhileGivenUp(t) ==
    /\ Mutant("PassOverWhileGivenUp")
    /\ Wakes(t)
    /\ Count(t) >= GivesUpAfter
    /\ PassOver(t)

DecidePassOverWhileWaiting(t) ==
    /\ Mutant("PassOverWhileWaiting")
    /\ Wakes(t)
    /\ Count(t) < GivesUpAfter
    /\ ~SlotFree
    /\ PassOver(t)

StartUpdate(t) ==
    /\ Wakes(t)
    /\ Count(t) < GivesUpAfter
    /\ SlotFree
    /\ turn' = [turn EXCEPT ![t] = "update"]
    /\ tracked' = IF Mutant("CountRunningInMemory") THEN tracked \cup {t} ELSE tracked
    /\ IF Mutant("RecordCursorAfterStart")
          THEN /\ unsaved' = [unsaved EXCEPT ![t] = logged[t]]
               /\ UNCHANGED cursor
          ELSE /\ cursor' = [cursor EXCEPT ![t] = logged[t]]
               /\ UNCHANGED unsaved
    /\ count' = [count EXCEPT ![t] = IF Mutant("NeverCount") THEN Count(t) ELSE Count(t) + 1]
    /\ afterNewMessage' = [afterNewMessage EXCEPT ![t] = FALSE]
    /\ told' = [told EXCEPT ![t] = @ \cup Pending(t)]
    /\ toldTwice' = (toldTwice \/ Pending(t) \cap told[t] # {})
    /\ cutIn' = (cutIn \/ ~Idle(t))
    /\ streak' = [streak EXCEPT ![t] = @ + 1]
    /\ sinceMessage' = [sinceMessage EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<log, queued, bounds, lost, dropped>>

Decide(t) ==
    /\ Idle(t) \/ Mutant("SkipIdleCheck")
    /\ \/ DecideQuiet(t)
       \/ DecidePassOverWhileGivenUp(t)
       \/ DecidePassOverWhileWaiting(t)
       \/ StartUpdate(t)

RecordCursorLate(t) ==
    /\ unsaved[t] # 0
    /\ cursor' = [cursor EXCEPT ![t] = unsaved[t]]
    /\ unsaved' = [unsaved EXCEPT ![t] = 0]
    /\ UNCHANGED <<log, count, afterNewMessage, turn, queued, tracked, bounds, ghosts>>

MessageReaches(t) ==
    /\ afterNewMessage' =
           IF Mutant("IgnoreMessages") THEN afterNewMessage
           ELSE [afterNewMessage EXCEPT ![t] = TRUE]
    /\ streak' = [streak EXCEPT ![t] = 0]
    /\ sinceMessage' = [sinceMessage EXCEPT ![t] = 0]
    /\ UNCHANGED <<told, toldTwice, lost, cutIn, dropped>>

SendMessage(t) ==
    /\ messages < MaxMessages
    /\ messages' = messages + 1
    /\ Idle(t)
    /\ turn' = [turn EXCEPT ![t] = "message"]
    /\ MessageReaches(t)
    /\ UNCHANGED <<log, cursor, count, queued, unsaved, tracked, restarts>>

Steer(t) ==
    /\ messages < MaxMessages
    /\ messages' = messages + 1
    /\ turn[t] # "idle"
    /\ MessageReaches(t)
    /\ UNCHANGED <<log, cursor, count, turn, queued, unsaved, tracked, restarts>>

QueueMessage(t) ==
    /\ messages < MaxMessages
    /\ messages' = messages + 1
    /\ ~Idle(t)
    /\ ~queued[t]
    /\ queued' = [queued EXCEPT ![t] = TRUE]
    /\ UNCHANGED <<log, cursor, count, afterNewMessage, turn, unsaved, tracked, restarts, ghosts>>

\* The Agent harness starts a Turn by itself, which is no message.
HarnessStartsTurn(t) ==
    /\ messages < MaxMessages
    /\ messages' = messages + 1
    /\ Idle(t)
    /\ turn' = [turn EXCEPT ![t] = "unprompted"]
    /\ afterNewMessage' =
           IF Mutant("UnpromptedCounts") THEN [afterNewMessage EXCEPT ![t] = TRUE]
           ELSE afterNewMessage
    /\ UNCHANGED <<log, cursor, count, queued, unsaved, tracked, restarts, ghosts>>

QueuedMessageStarts(t) ==
    /\ queued[t]
    /\ queued' = [queued EXCEPT ![t] = FALSE]
    /\ turn' = [turn EXCEPT ![t] = "message"]
    /\ tracked' = tracked \ {t}
    /\ MessageReaches(t)
    /\ UNCHANGED <<log, cursor, count, unsaved, bounds>>

TurnEnds(t) ==
    /\ turn[t] # "idle"
    /\ \/ /\ turn' = [turn EXCEPT ![t] = "idle"]
          /\ tracked' = tracked \ {t}
          /\ UNCHANGED <<log, cursor, count, afterNewMessage, queued, unsaved, bounds, ghosts>>
       \/ QueuedMessageStarts(t)

StoppedQueueStarts(t) ==
    /\ turn[t] = "idle"
    /\ QueuedMessageStarts(t)

\* A local Thread's Turn is interrupted and a Sandbox Thread's keeps running. An Update to the
\* Global chat, one of the Retries, is delivered again in the same Turn.
GlassRestarts ==
    /\ restarts < MaxRestarts
    /\ restarts' = restarts + 1
    /\ \E interrupted \in SUBSET {t \in Subscribers : turn[t] # "idle"} :
           /\ \A t \in interrupted :
                  t \in Retries /\ turn[t] = "update" => Mutant("GlobalChatDoesNotRetry")
           /\ turn' = [t \in Subscribers |-> IF t \in interrupted THEN "idle" ELSE turn[t]]
           /\ dropped' = (dropped \/ \E t \in interrupted : t \in Retries /\ turn[t] = "update")
    /\ unsaved' = [t \in Subscribers |-> 0]
    /\ tracked' = {}
    /\ count' = IF Mutant("RestartForgetsCount") THEN [t \in Subscribers |-> 0] ELSE count
    /\ UNCHANGED <<log, cursor, afterNewMessage, queued, messages, told, toldTwice, lost, cutIn,
                   streak, sinceMessage>>

Next ==
    \/ \E t \in Subscribers :
           \/ RecordEvent(t)
           \/ Decide(t)
           \/ RecordCursorLate(t)
           \/ SendMessage(t)
           \/ Steer(t)
           \/ QueueMessage(t)
           \/ HarnessStartsTurn(t)
           \/ TurnEnds(t)
           \/ StoppedQueueStarts(t)
    \/ GlassRestarts

Spec == Init /\ [][Next]_vars

NeverCutsIn == ~cutIn

ToldOnce == ~toldTwice

NoneLost == ~lost

RunsAtMostTheLimit == Cardinality(Running) <= RunAtOnce

StopsAtTheLimit == \A t \in Subscribers : streak[t] <= GivesUpAfter

MessageLetsItTryAgain == \A t \in Subscribers : Idle(t) => Count(t) <= sinceMessage[t]

GlobalChatUpdatesSurviveRestart == ~dropped
==============================================================================
