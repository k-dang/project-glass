-------------------------------- MODULE Updates --------------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Threads, RunAtOnce, GivesUpAfter, MaxEvents, MaxMessages, MaxRestarts, Broken

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
    streak,
    sinceMessage

vars == <<logged, wakes, cursor, count, afterNewMessage, turn, queued, unsaved, tracked,
          messages, restarts, told, toldTwice, lost, cutIn, streak, sinceMessage>>

log == <<logged, wakes>>
ghosts == <<told, toldTwice, lost, cutIn, streak, sinceMessage>>
bounds == <<messages, restarts>>

Mutant(name) == name \in Broken

Symmetry == Permutations(Threads)

Init ==
    /\ logged = [t \in Threads |-> 0]
    /\ wakes = [t \in Threads |-> {}]
    /\ cursor = [t \in Threads |-> 0]
    /\ count = [t \in Threads |-> 0]
    /\ afterNewMessage = [t \in Threads |-> FALSE]
    /\ turn = [t \in Threads |-> "idle"]
    /\ queued = [t \in Threads |-> FALSE]
    /\ unsaved = [t \in Threads |-> 0]
    /\ tracked = {}
    /\ messages = 0
    /\ restarts = 0
    /\ told = [t \in Threads |-> {}]
    /\ toldTwice = FALSE
    /\ lost = FALSE
    /\ cutIn = FALSE
    /\ streak = [t \in Threads |-> 0]
    /\ sinceMessage = [t \in Threads |-> 0]

Idle(t) == turn[t] = "idle" /\ ~queued[t]

Running == {t \in Threads : turn[t] = "update"}

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
                   toldTwice, cutIn, streak, sinceMessage>>

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
    /\ UNCHANGED <<log, queued, bounds, lost>>

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
    /\ UNCHANGED <<told, toldTwice, lost, cutIn>>

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

GlassRestarts ==
    /\ restarts < MaxRestarts
    /\ restarts' = restarts + 1
    /\ \E interrupted \in SUBSET {t \in Threads : turn[t] # "idle"} :
           turn' = [t \in Threads |-> IF t \in interrupted THEN "idle" ELSE turn[t]]
    /\ unsaved' = [t \in Threads |-> 0]
    /\ tracked' = {}
    /\ count' = IF Mutant("RestartForgetsCount") THEN [t \in Threads |-> 0] ELSE count
    /\ UNCHANGED <<log, cursor, afterNewMessage, queued, messages, ghosts>>

Next ==
    \/ \E t \in Threads :
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

StopsAtTheLimit == \A t \in Threads : streak[t] <= GivesUpAfter

MessageLetsItTryAgain == \A t \in Threads : Idle(t) => Count(t) <= sinceMessage[t]
==============================================================================
