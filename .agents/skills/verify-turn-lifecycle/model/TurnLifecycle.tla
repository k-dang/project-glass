---------------------------- MODULE TurnLifecycle ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxTurns, MaxQueued, MaxJournal, Broken

Turns == 1..MaxTurns
NoTurn == 0
Final == {"Done", "Failed", "Stopped", "Interrupted"}
HostEndings == {"Done", "Failed", "Stopped"}

VARIABLES
    ended,
    retries,
    stopAsked,
    delivering,
    hostTurn,
    journal,
    connected,
    queued,
    started,
    partOnFailed

vars == <<ended, retries, stopAsked, delivering, hostTurn, journal,
          connected, queued, started, partOnFailed>>

Mutant(name) == name \in Broken

Running == {t \in Turns : ended[t] = "running"}

Init ==
    /\ ended = [t \in Turns |-> "unstarted"]
    /\ retries = [t \in Turns |-> FALSE]
    /\ stopAsked = [t \in Turns |-> FALSE]
    /\ delivering = {}
    /\ hostTurn = NoTurn
    /\ journal = <<>>
    /\ connected = TRUE
    /\ queued = 0
    /\ started = 0
    /\ partOnFailed = FALSE

CanStart == started < MaxTurns

StartTurn(retried) ==
    LET t == started + 1 IN
    /\ ended' = [ended EXCEPT ![t] = "running"]
    /\ retries' = [retries EXCEPT ![t] = retried]
    /\ delivering' = delivering \cup {t}
    /\ started' = t

Accepts(t, e) ==
    /\ \/ ended[t] = "running"
       \/ ended[t] = "CutOff"
       \/ Mutant("FinalEndingsOverwritable") /\ ended[t] # "unstarted"
    /\ e # "Stopped" \/ ~retries[t]

EndWith(t, e, pending) ==
    IF Accepts(t, e)
    THEN LET after == [ended EXCEPT ![t] = e] IN
         IF /\ \A u \in Turns : after[u] # "running"
            /\ queued > 0
            /\ e \in {"Done", "Failed"}
            /\ CanStart
         THEN /\ ended' = [after EXCEPT ![started + 1] = "running"]
              /\ retries' = [retries EXCEPT ![started + 1] = FALSE]
              /\ delivering' = pending \cup {started + 1}
              /\ started' = started + 1
              /\ queued' = queued - 1
         ELSE /\ ended' = after
              /\ delivering' = pending
              /\ UNCHANGED <<retries, started, queued>>
    ELSE /\ delivering' = pending
         /\ UNCHANGED <<ended, retries, started, queued>>

ApplyEnd(t, e) == EndWith(t, e, delivering)

YouSend ==
    IF Running = {} \/ Mutant("SendIgnoresRunningTurn")
    THEN /\ CanStart
         /\ StartTurn(FALSE)
         /\ UNCHANGED <<stopAsked, hostTurn, journal, connected, queued, partOnFailed>>
    ELSE /\ queued < MaxQueued
         /\ queued' = queued + 1
         /\ UNCHANGED <<ended, retries, stopAsked, delivering, hostTurn, journal,
                        connected, started, partOnFailed>>

GlobalChatStartsUpdate ==
    /\ Running = {}
    /\ queued = 0
    /\ CanStart
    /\ StartTurn(TRUE)
    /\ UNCHANGED <<stopAsked, hostTurn, journal, connected, queued, partOnFailed>>

YouSendQueued ==
    /\ Running = {}
    /\ queued > 0
    /\ CanStart
    /\ StartTurn(FALSE)
    /\ queued' = queued - 1
    /\ UNCHANGED <<stopAsked, hostTurn, journal, connected, partOnFailed>>

HostTakesTurn(t) ==
    /\ t \in delivering
    /\ connected
    /\ hostTurn = NoTurn
    /\ delivering' = delivering \ {t}
    /\ IF ended[t] = "running"
       THEN /\ hostTurn' = t
            /\ UNCHANGED journal
       ELSE /\ Len(journal) < MaxJournal
            /\ journal' = Append(journal, [turn |-> t, kind |-> "end", ending |-> "Stopped"])
            /\ UNCHANGED hostTurn
    /\ UNCHANGED <<ended, retries, stopAsked, connected, queued, started, partOnFailed>>

HostRefusesTurn(t) ==
    /\ t \in delivering
    /\ ~connected \/ hostTurn # NoTurn
    /\ IF ended[t] = "running" /\ ~retries[t]
       THEN EndWith(t, "Failed", delivering \ {t})
       ELSE /\ delivering' = delivering \ {t}
            /\ UNCHANGED <<ended, retries, started, queued>>
    /\ UNCHANGED <<stopAsked, hostTurn, journal, connected, partOnFailed>>

DeliveryTimesOut(t) ==
    /\ t \in delivering
    /\ connected
    /\ hostTurn = NoTurn
    /\ ended[t] = "running"
    /\ hostTurn' = t
    /\ IF ~retries[t]
       THEN EndWith(t, "Failed", delivering \ {t})
       ELSE /\ delivering' = delivering \ {t}
            /\ UNCHANGED <<ended, retries, started, queued>>
    /\ UNCHANGED <<stopAsked, journal, connected, partOnFailed>>

AgentWritesPart ==
    /\ hostTurn # NoTurn
    /\ Len(journal) < MaxJournal
    /\ journal' = Append(journal, [turn |-> hostTurn, kind |-> "part", ending |-> "none"])
    /\ UNCHANGED <<ended, retries, stopAsked, delivering, hostTurn, connected, queued,
                   started, partOnFailed>>

AgentEndsTurn(e) ==
    /\ hostTurn # NoTurn
    /\ Len(journal) < MaxJournal
    /\ journal' = Append(journal, [turn |-> hostTurn, kind |-> "end", ending |-> e])
    /\ hostTurn' = NoTurn
    /\ UNCHANGED <<ended, retries, stopAsked, delivering, connected, queued, started,
                   partOnFailed>>

GlassSavesJournal ==
    /\ connected
    /\ journal # <<>>
    /\ LET event == Head(journal) IN
       /\ journal' = Tail(journal)
       /\ IF event.kind = "part"
          THEN /\ IF ended[event.turn] = "Failed" /\ ~Mutant("PartsWrittenAfterFailure")
                  THEN UNCHANGED partOnFailed
                  ELSE partOnFailed' = (partOnFailed \/ ended[event.turn] = "Failed")
               /\ UNCHANGED <<ended, retries, delivering, started, queued>>
          ELSE /\ ApplyEnd(event.turn, event.ending)
               /\ UNCHANGED partOnFailed
    /\ UNCHANGED <<stopAsked, hostTurn, connected>>

YouStop ==
    \E t \in Running :
        /\ stopAsked' = [stopAsked EXCEPT ![t] = TRUE]
        /\ retries' = IF Mutant("StopKeepsRetrying") THEN retries
                      ELSE [retries EXCEPT ![t] = FALSE]
        /\ IF connected /\ hostTurn = t
           THEN /\ Len(journal) < MaxJournal
                /\ hostTurn' = NoTurn
                /\ journal' = Append(journal, [turn |-> t, kind |-> "end", ending |-> "Stopped"])
                /\ UNCHANGED ended
           ELSE /\ ended' = [ended EXCEPT ![t] = "Stopped"]
                /\ UNCHANGED <<hostTurn, journal>>
        /\ UNCHANGED <<delivering, started, queued, connected, partOnFailed>>

CutOffRunning ==
    [t \in Turns |->
        IF ended[t] = "running" /\ (~retries[t] \/ Mutant("RetriedTurnsCutOff"))
        THEN "CutOff" ELSE ended[t]]

GlassLosesHost ==
    /\ connected
    /\ connected' = FALSE
    /\ ended' = CutOffRunning
    /\ UNCHANGED <<retries, stopAsked, delivering, hostTurn, journal, queued, started,
                   partOnFailed>>

GlassReconnects ==
    /\ ~connected
    /\ connected' = TRUE
    /\ UNCHANGED <<ended, retries, stopAsked, delivering, hostTurn, journal, queued,
                   started, partOnFailed>>

AgentHostReplaced ==
    /\ ~connected
    /\ connected' = TRUE
    /\ hostTurn' = NoTurn
    /\ journal' = <<>>
    /\ ended' = CutOffRunning
    /\ UNCHANGED <<retries, stopAsked, delivering, queued, started, partOnFailed>>

Carried(t) ==
    \/ hostTurn = t
    \/ \E i \in 1..Len(journal) : journal[i].turn = t /\ journal[i].kind = "end"

GlassRestarts ==
    /\ connected' = TRUE
    /\ delivering' = {t \in Running : retries[t] /\ ~Carried(t)}
    /\ ended' = [t \in Turns |->
                    IF /\ ended[t] = "running"
                       /\ ~retries[t]
                       /\ ~Carried(t)
                       /\ ~Mutant("RestartKeepsLostTurns")
                    THEN "Interrupted" ELSE ended[t]]
    /\ UNCHANGED <<retries, stopAsked, hostTurn, journal, queued, started, partOnFailed>>

Next ==
    \/ YouSend
    \/ GlobalChatStartsUpdate
    \/ YouSendQueued
    \/ \E t \in Turns : HostTakesTurn(t)
    \/ \E t \in Turns : HostRefusesTurn(t)
    \/ \E t \in Turns : DeliveryTimesOut(t)
    \/ AgentWritesPart
    \/ \E e \in HostEndings : AgentEndsTurn(e)
    \/ GlassSavesJournal
    \/ YouStop
    \/ GlassLosesHost
    \/ GlassReconnects
    \/ AgentHostReplaced
    \/ GlassRestarts

Spec == Init /\ [][Next]_vars

OneRunningTurn == Cardinality(Running) <= 1

NoPartsAfterFailure == ~partOnFailed

RetriedTurnsSurviveLoss ==
    \A t \in Turns : retries[t] => ended[t] \notin {"CutOff", "Interrupted"}

Owned(t) == hostTurn = t \/ t \in delivering \/ Carried(t)

OrdinaryTurnsEnd == \A t \in Running : ~retries[t] => Owned(t)

StoppedTurnsEnd == \A t \in Running : stopAsked[t] => Owned(t)

FinalEndingsStay ==
    [][\A t \in Turns : ended[t] \in Final => ended'[t] = ended[t]]_vars
==============================================================================
