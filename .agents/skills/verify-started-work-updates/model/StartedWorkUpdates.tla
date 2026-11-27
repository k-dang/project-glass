-------------------------- MODULE StartedWorkUpdates --------------------------
EXTENDS Naturals

CONSTANTS MaxOutcomes, Broken

Kinds == {"waiting", "finished", "failed"}

VARIABLES
    latest,
    latestKind,
    outcomeAt,
    update,
    carried,
    carriedKind,
    seenThrough,
    agentKnows,
    youSaw,
    reported,
    reportedTwice

vars == <<latest, latestKind, outcomeAt, update, carried, carriedKind, seenThrough, agentKnows,
          youSaw, reported, reportedTwice>>

Mutant(name) == name \in Broken

Init ==
    /\ latest = 0
    /\ latestKind = "none"
    /\ outcomeAt = 0
    /\ update = "none"
    /\ carried = 0
    /\ carriedKind = "none"
    /\ seenThrough = 0
    /\ agentKnows = 0
    /\ youSaw = 0
    /\ reported = {}
    /\ reportedTwice = FALSE

Max(a, b) == IF a > b THEN a ELSE b

StartedThreadReachesOutcome(kind) ==
    /\ latest < MaxOutcomes
    /\ latest' = latest + 1
    /\ latestKind' = kind
    /\ UNCHANGED <<outcomeAt, update, carried, carriedKind, seenThrough, agentKnows, youSaw,
                   reported, reportedTwice>>

YouOpenStartedThread ==
    /\ seenThrough' = latest
    /\ youSaw' = latest
    /\ UNCHANGED <<latest, latestKind, outcomeAt, update, carried, carriedKind, agentKnows,
                   reported, reportedTwice>>

IsNew == IF Mutant("ReportCoveredOutcomes") THEN latest >= outcomeAt ELSE latest > outcomeAt

StarterSendsUpdate ==
    /\ update # "running"
    /\ latest > 0
    /\ IsNew
    /\ update' = "running"
    /\ carried' = latest
    /\ carriedKind' = latestKind
    /\ outcomeAt' = latest
    /\ reported' = reported \cup {latest}
    /\ reportedTwice' = (reportedTwice \/ latest \in reported)
    /\ UNCHANGED <<latest, latestKind, seenThrough, agentKnows, youSaw>>

Reconcile ==
    /\ update = "delivered" \/ (update = "running" /\ Mutant("ReconcileWhileUpdateRuns"))
    /\ outcomeAt > 0
    /\ carriedKind # "waiting" \/ Mutant("ReconcileMarksWaitingSeen")
    /\ seenThrough' = Max(seenThrough, outcomeAt)
    /\ UNCHANGED <<latest, latestKind, outcomeAt, update, carried, carriedKind, agentKnows, youSaw,
                   reported, reportedTwice>>

UpdateReachesAgent ==
    /\ update = "running"
    /\ update' = "delivered"
    /\ agentKnows' = Max(agentKnows, carried)
    /\ UNCHANGED <<latest, latestKind, outcomeAt, carried, carriedKind, seenThrough, youSaw,
                   reported, reportedTwice>>

UpdateTurnFails ==
    /\ update = "running"
    /\ update' = "failed"
    /\ UNCHANGED <<latest, latestKind, outcomeAt, carried, carriedKind, seenThrough, agentKnows,
                   youSaw, reported, reportedTwice>>

Next ==
    \/ \E kind \in Kinds : StartedThreadReachesOutcome(kind)
    \/ YouOpenStartedThread
    \/ StarterSendsUpdate
    \/ Reconcile
    \/ UpdateReachesAgent
    \/ UpdateTurnFails

Spec == Init /\ [][Next]_vars

ReportedOnce == ~reportedTwice

StillPending(o) ==
    \/ outcomeAt < o
    \/ update = "running" /\ carried >= o

WaitingStaysUnseen ==
    latestKind = "waiting" /\ youSaw < latest => seenThrough < latest

FinishedWorkReachesSomeone ==
    latestKind \in {"finished", "failed"} /\ latest > 0 =>
        \/ agentKnows >= latest
        \/ youSaw >= latest
        \/ seenThrough < latest
        \/ StillPending(latest)
==============================================================================
