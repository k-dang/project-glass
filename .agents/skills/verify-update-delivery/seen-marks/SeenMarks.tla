------------------------------- MODULE SeenMarks -------------------------------
EXTENDS Naturals

CONSTANTS MaxEvents, MaxOtherTurns, MaxRestarts, Broken

VARIABLES
    logged,
    waits,
    cursor,
    turn,
    carried,
    lastEnding,
    lastTold,
    otherTurns,
    restarts,
    heard,
    seen

vars == <<logged, waits, cursor, turn, carried, lastEnding, lastTold, otherTurns, restarts, heard,
          seen>>

ended == <<lastEnding, lastTold, heard>>

Mutant(name) == name \in Broken

Init ==
    /\ logged = 0
    /\ waits = {}
    /\ cursor = 0
    /\ turn = "idle"
    /\ carried = {}
    /\ lastEnding = "none"
    /\ lastTold = {}
    /\ otherTurns = 0
    /\ restarts = 0
    /\ heard = {}
    /\ seen = {}

Pending == {e \in 1..logged : e > cursor}

\* The glass Source records that work the subscriber started finished, failed, or waits on the user.
RecordEvent ==
    /\ logged < MaxEvents
    /\ logged' = logged + 1
    /\ \/ waits' = waits \cup {logged + 1}
       \/ UNCHANGED waits
    /\ UNCHANGED <<cursor, turn, carried, ended, otherTurns, restarts, seen>>

StartUpdate ==
    /\ turn = "idle"
    /\ Pending # {}
    /\ turn' = "update"
    /\ carried' = Pending
    /\ cursor' = logged
    /\ UNCHANGED <<logged, waits, ended, otherTurns, restarts, seen>>

StartOtherTurn ==
    /\ turn = "idle"
    /\ otherTurns < MaxOtherTurns
    /\ otherTurns' = otherTurns + 1
    /\ turn' = "other"
    /\ UNCHANGED <<logged, waits, cursor, carried, ended, restarts, seen>>

\* An Update ends Failed only when it never reached the agent. Every other ending, Interrupted by a
\* restart among them, means the agent got it.
EndTurn(reached) ==
    /\ turn # "idle"
    /\ turn' = "idle"
    /\ lastEnding' = IF turn # "update" THEN "other" ELSE IF reached THEN "reached" ELSE "failed"
    /\ lastTold' = IF turn = "update" THEN carried ELSE {}
    /\ heard' = IF turn = "update" /\ reached THEN heard \cup carried ELSE heard
    /\ UNCHANGED <<logged, waits, cursor, carried, otherTurns, seen>>

TurnEnds == \E reached \in BOOLEAN : EndTurn(reached) /\ UNCHANGED restarts

GlassRestarts ==
    /\ restarts < MaxRestarts
    /\ restarts' = restarts + 1
    /\ EndTurn(TRUE)

\* After any Turn ends, Glass reads the subscriber's last ended Turn and, when it is an Update that
\* reached the agent, marks the finished work it told seen.
MarkTold ==
    /\ \/ lastEnding = "reached"
       \/ Mutant("MarkFailedUpdate") /\ lastEnding = "failed"
       \/ Mutant("MarkRunningUpdate") /\ turn = "update"
    /\ LET told == IF Mutant("MarkRunningUpdate") /\ turn = "update" THEN carried ELSE lastTold
       IN seen' = seen \cup (IF Mutant("MarkWaiting") THEN told ELSE told \ waits)
    /\ UNCHANGED <<logged, waits, cursor, turn, carried, ended, otherTurns, restarts>>

Next ==
    \/ RecordEvent
    \/ StartUpdate
    \/ StartOtherTurn
    \/ TurnEnds
    \/ GlassRestarts
    \/ MarkTold

Spec == Init /\ [][Next]_vars

WaitingStaysUnseen == seen \cap waits = {}

SeenOnlyOnceHeard == seen \subseteq heard
==============================================================================
