-------------------------- MODULE PullRequestUpdates --------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Threads, RunAtOnce, GivesUpAfter, MaxStates, MaxMessages, MaxRestarts, Broken

VARIABLES
    pr,
    version,
    told,
    count,
    afterNewMessage,
    turn,
    queued,
    unsaved,
    owed,
    tracked,
    messages,
    restarts,
    sent,
    toldTwice,
    cutIn,
    stale,
    streak,
    sinceMessage

vars == <<pr, version, told, count, afterNewMessage, turn, queued, unsaved, owed, tracked,
          messages, restarts, sent, toldTwice, cutIn, stale, streak, sinceMessage>>

mirror == <<pr, version>>
ghosts == <<sent, toldTwice, cutIn, stale, streak, sinceMessage>>
bounds == <<messages, restarts>>

Mutant(name) == name \in Broken

Symmetry == Permutations(Threads)

Init ==
    /\ pr = [t \in Threads |-> "clear"]
    /\ version = [t \in Threads |-> 0]
    /\ told = [t \in Threads |-> 0]
    /\ count = [t \in Threads |-> 0]
    /\ afterNewMessage = [t \in Threads |-> FALSE]
    /\ turn = [t \in Threads |-> "idle"]
    /\ queued = [t \in Threads |-> FALSE]
    /\ unsaved = [t \in Threads |-> 0]
    /\ owed = [t \in Threads |-> 0]
    /\ tracked = {}
    /\ messages = 0
    /\ restarts = 0
    /\ sent = [t \in Threads |-> {}]
    /\ toldTwice = FALSE
    /\ cutIn = FALSE
    /\ stale = FALSE
    /\ streak = [t \in Threads |-> 0]
    /\ sinceMessage = [t \in Threads |-> 0]

Idle(t) == turn[t] = "idle" /\ ~queued[t]

Running == {t \in Threads : turn[t] = "update"}

Count(t) == IF afterNewMessage[t] THEN 0 ELSE count[t]

IsNew(t) == pr[t] = "failing" /\ told[t] # version[t]

SlotFree ==
    \/ Mutant("IgnoreLimit")
    \/ Cardinality(IF Mutant("CountRunningInMemory") THEN tracked ELSE Running) < RunAtOnce

ChecksFail(t) ==
    /\ version[t] < MaxStates
    /\ pr' = [pr EXCEPT ![t] = "failing"]
    /\ version' = [version EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<told, count, afterNewMessage, turn, queued, unsaved, owed, tracked, bounds,
                   ghosts>>

ChecksRunAgain(t) ==
    /\ pr[t] = "failing"
    /\ pr' = [pr EXCEPT ![t] = "rerun"]
    /\ UNCHANGED <<version, told, count, afterNewMessage, turn, queued, unsaved, owed, tracked,
                   bounds, ghosts>>

ChecksPass(t) ==
    /\ pr[t] # "clear"
    /\ pr' = [pr EXCEPT ![t] = "clear"]
    /\ streak' = [streak EXCEPT ![t] = 0]
    /\ UNCHANGED <<version, told, count, afterNewMessage, turn, queued, unsaved, owed, tracked,
                   bounds, sent, toldTwice, cutIn, stale, sinceMessage>>

StartUpdate(t, tells, records) ==
    /\ turn' = [turn EXCEPT ![t] = "update"]
    /\ tracked' = IF Mutant("CountRunningInMemory") THEN tracked \cup {t} ELSE tracked
    /\ owed' = [owed EXCEPT ![t] = 0]
    /\ told' = IF records THEN [told EXCEPT ![t] = tells] ELSE told
    /\ unsaved' = IF records THEN unsaved ELSE [unsaved EXCEPT ![t] = tells]
    /\ count' = [count EXCEPT ![t] = IF Mutant("NeverCount") THEN Count(t) ELSE Count(t) + 1]
    /\ afterNewMessage' = [afterNewMessage EXCEPT ![t] = FALSE]
    /\ sent' = [sent EXCEPT ![t] = @ \cup {tells}]
    /\ toldTwice' = (toldTwice \/ tells \in sent[t])
    /\ cutIn' = (cutIn \/ ~Idle(t))
    /\ stale' = (stale \/ ~(pr[t] = "failing" /\ version[t] = tells))
    /\ streak' = [streak EXCEPT ![t] = @ + 1]
    /\ sinceMessage' = [sinceMessage EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<mirror, queued, bounds>>

DecideNothingHolds(t) ==
    /\ pr[t] # "failing"
    /\ told' = [told EXCEPT ![t] = 0]
    /\ count' = [count EXCEPT ![t] =
                    IF pr[t] = "clear" \/ Mutant("RerunResetsCount") THEN 0 ELSE Count(t)]
    /\ afterNewMessage' = [afterNewMessage EXCEPT ![t] = FALSE]
    /\ UNCHANGED <<mirror, turn, queued, unsaved, owed, tracked, bounds, ghosts>>

DecideToSend(t) ==
    /\ IsNew(t)
    /\ Count(t) < GivesUpAfter
    /\ SlotFree
    /\ StartUpdate(t, version[t], ~Mutant("RecordToldAfterStart"))

DecideToWait(t) ==
    /\ IsNew(t)
    /\ Count(t) < GivesUpAfter
    /\ ~SlotFree
    /\ Mutant("SendWhatWaited")
    /\ owed' = [owed EXCEPT ![t] = version[t]]
    /\ UNCHANGED <<mirror, told, count, afterNewMessage, turn, queued, unsaved, tracked, bounds,
                   ghosts>>

SendWhatWaited(t) ==
    /\ Mutant("SendWhatWaited")
    /\ owed[t] # 0
    /\ SlotFree
    /\ StartUpdate(t, owed[t], TRUE)

Decide(t) ==
    /\ Idle(t) \/ Mutant("SkipIdleCheck")
    /\ \/ DecideNothingHolds(t)
       \/ DecideToSend(t)
       \/ DecideToWait(t)
       \/ SendWhatWaited(t)

RecordToldLate(t) ==
    /\ unsaved[t] # 0
    /\ told' = [told EXCEPT ![t] = unsaved[t]]
    /\ unsaved' = [unsaved EXCEPT ![t] = 0]
    /\ UNCHANGED <<mirror, count, afterNewMessage, turn, queued, owed, tracked, bounds, ghosts>>

MessageReaches(t) ==
    /\ afterNewMessage' =
           IF Mutant("IgnoreMessages") THEN afterNewMessage
           ELSE [afterNewMessage EXCEPT ![t] = TRUE]
    /\ streak' = [streak EXCEPT ![t] = 0]
    /\ sinceMessage' = [sinceMessage EXCEPT ![t] = 0]
    /\ UNCHANGED <<sent, toldTwice, cutIn, stale>>

YouSendMessage(t) ==
    /\ messages < MaxMessages
    /\ messages' = messages + 1
    /\ Idle(t)
    /\ turn' = [turn EXCEPT ![t] = "user"]
    /\ MessageReaches(t)
    /\ UNCHANGED <<mirror, told, count, queued, unsaved, owed, tracked, restarts>>

YouSteer(t) ==
    /\ messages < MaxMessages
    /\ messages' = messages + 1
    /\ turn[t] # "idle"
    /\ MessageReaches(t)
    /\ UNCHANGED <<mirror, told, count, turn, queued, unsaved, owed, tracked, restarts>>

YouQueueMessage(t) ==
    /\ messages < MaxMessages
    /\ messages' = messages + 1
    /\ ~Idle(t)
    /\ ~queued[t]
    /\ queued' = [queued EXCEPT ![t] = TRUE]
    /\ UNCHANGED <<mirror, told, count, afterNewMessage, turn, unsaved, owed, tracked, restarts,
                   ghosts>>

QueuedMessageStarts(t) ==
    /\ queued[t]
    /\ queued' = [queued EXCEPT ![t] = FALSE]
    /\ turn' = [turn EXCEPT ![t] = "user"]
    /\ tracked' = tracked \ {t}
    /\ MessageReaches(t)
    /\ UNCHANGED <<mirror, told, count, unsaved, owed, bounds>>

TurnEnds(t) ==
    /\ turn[t] # "idle"
    /\ \/ /\ turn' = [turn EXCEPT ![t] = "idle"]
          /\ tracked' = tracked \ {t}
          /\ UNCHANGED <<mirror, told, count, afterNewMessage, queued, unsaved, owed, bounds,
                         ghosts>>
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
    /\ owed' = [t \in Threads |-> 0]
    /\ tracked' = {}
    /\ count' = IF Mutant("RestartForgetsCount") THEN [t \in Threads |-> 0] ELSE count
    /\ UNCHANGED <<mirror, told, afterNewMessage, queued, messages, ghosts>>

Next ==
    \/ \E t \in Threads :
           \/ ChecksFail(t)
           \/ ChecksRunAgain(t)
           \/ ChecksPass(t)
           \/ Decide(t)
           \/ RecordToldLate(t)
           \/ YouSendMessage(t)
           \/ YouSteer(t)
           \/ YouQueueMessage(t)
           \/ TurnEnds(t)
           \/ StoppedQueueStarts(t)
    \/ GlassRestarts

Spec == Init /\ [][Next]_vars

NeverCutsIn == ~cutIn

ToldOnce == ~toldTwice

TellsWhatIsStillTrue == ~stale

RunsAtMostTheLimit == Cardinality(Running) <= RunAtOnce

StopsAtTheLimit == \A t \in Threads : streak[t] <= GivesUpAfter

MessageLetsItTryAgain == \A t \in Threads : Idle(t) => Count(t) <= sinceMessage[t]
==============================================================================
