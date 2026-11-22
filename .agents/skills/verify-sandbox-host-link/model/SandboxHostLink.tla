--------------------------- MODULE SandboxHostLink ---------------------------
EXTENDS Naturals

CONSTANTS MaxTurns, MaxHosts, Broken

Turns == 1..MaxTurns
None == 0

VARIABLES
    host,
    hostUp,
    compatible,
    hostTurn,
    pendingEnd,
    replacing,
    position,
    turnOnLostHost,
    following,
    running,
    delivering,
    started,
    ranOn,
    cutOffUnrun, interruptedRan,
    taken

vars == <<host, hostUp, compatible, hostTurn, pendingEnd, replacing, position, turnOnLostHost,
          following, running, delivering, started, ranOn, cutOffUnrun, interruptedRan, taken>>

hostVars == <<host, hostUp, compatible, hostTurn, pendingEnd>>

Mutant(name) == name \in Broken

Init ==
    /\ host = 1
    /\ hostUp = TRUE
    /\ compatible = TRUE
    /\ hostTurn = None
    /\ pendingEnd = None
    /\ replacing = FALSE
    /\ position = None
    /\ turnOnLostHost = None
    /\ following = None
    /\ running = None
    /\ delivering = None
    /\ started = 0
    /\ ranOn = [t \in Turns |-> None]
    /\ cutOffUnrun = FALSE
    /\ interruptedRan = FALSE
    /\ taken = None

YouSendMessage ==
    /\ running = None
    /\ started < MaxTurns
    /\ started' = started + 1
    /\ running' = started + 1
    /\ delivering' = started + 1
    /\ UNCHANGED <<hostVars, replacing, position, turnOnLostHost, following, ranOn, cutOffUnrun, interruptedRan,
                   taken>>

HostTakesTurn ==
    /\ delivering # None
    /\ following = host
    /\ hostTurn = None
    /\ delivering' = None
    /\ IF running = delivering
       THEN /\ hostTurn' = delivering
            /\ ranOn' = [ranOn EXCEPT ![delivering] = host]
            /\ taken' = delivering
       ELSE UNCHANGED <<hostTurn, ranOn, taken>>
    /\ UNCHANGED <<host, hostUp, compatible, pendingEnd, replacing, position, turnOnLostHost, following,
                   running, started, cutOffUnrun, interruptedRan>>

DeliveryFails ==
    /\ delivering # None
    /\ delivering' = None
    /\ running' = IF running = delivering THEN None ELSE running
    /\ UNCHANGED <<hostVars, replacing, position, turnOnLostHost, following, started, ranOn,
                   cutOffUnrun, interruptedRan, taken>>

AgentEndsTurn ==
    /\ hostTurn # None
    /\ pendingEnd = None
    /\ pendingEnd' = hostTurn
    /\ hostTurn' = None
    /\ UNCHANGED <<host, hostUp, compatible, replacing, position, turnOnLostHost, following,
                   running, delivering, started, ranOn, cutOffUnrun, interruptedRan, taken>>

GlassSavesJournal ==
    /\ following = host
    /\ pendingEnd # None
    /\ running' = IF running = pendingEnd THEN None ELSE running
    /\ pendingEnd' = None
    /\ UNCHANGED <<host, hostUp, compatible, hostTurn, replacing, position, turnOnLostHost, following,
                   delivering, started, ranOn, cutOffUnrun, interruptedRan, taken>>

Release ==
    /\ turnOnLostHost' =
           IF Mutant("ReleaseKeepsOldTurn") THEN turnOnLostHost
           ELSE IF running # None /\ running = taken THEN running
           ELSE None
    /\ following' = None

ConnectionDrops ==
    /\ following # None
    /\ Release
    /\ UNCHANGED <<hostVars, replacing, position, running, delivering, started, ranOn,
                   cutOffUnrun, interruptedRan, taken>>

SandboxRestartsHost ==
    /\ hostUp
    /\ host < MaxHosts
    /\ host' = host + 1
    /\ UNCHANGED hostUp
    /\ compatible' = TRUE
    /\ hostTurn' = None
    /\ pendingEnd' = None
    /\ IF following # None THEN Release ELSE UNCHANGED <<turnOnLostHost, following>>
    /\ UNCHANGED <<replacing, position, running, delivering, started, ranOn, cutOffUnrun, interruptedRan, taken>>

GlassFindsOtherProtocol ==
    /\ following = None
    /\ ~compatible
    /\ ~replacing
    /\ replacing' = TRUE
    /\ UNCHANGED <<hostVars, position, turnOnLostHost, following, running, delivering, started,
                   ranOn, cutOffUnrun, interruptedRan, taken>>

GlassStopsOldHost ==
    /\ following = None
    /\ replacing
    /\ hostUp
    /\ hostUp' = FALSE
    /\ hostTurn' = None
    /\ pendingEnd' = None
    /\ UNCHANGED <<host, compatible, replacing, position, turnOnLostHost, following, running,
                   delivering, started, ranOn, cutOffUnrun, interruptedRan, taken>>

GlassStartsNewHost ==
    /\ following = None
    /\ replacing
    /\ host < MaxHosts
    /\ host' = host + 1
    /\ hostUp' = TRUE
    /\ compatible' = TRUE
    /\ hostTurn' = None
    /\ pendingEnd' = None
    /\ UNCHANGED <<replacing, position, turnOnLostHost, following, running, delivering, started,
                   ranOn, cutOffUnrun, interruptedRan, taken>>

Carried(t) == t \in {hostTurn, pendingEnd} \/ (Mutant("SameHostKeepsLostTurn") /\ position = host)

EndsLost(t) == t # None /\ ~Carried(t) /\ ~Mutant("NewHostKeepsLostTurn")

EndsAsCutOff(t) == t = taken \/ Mutant("CutsOffUntakenTurn")

GlassFollowsHost ==
    /\ following = None
    /\ hostUp
    /\ compatible
    /\ replacing' = FALSE
    /\ following' = host
    /\ position' = host
    /\ IF EndsLost(turnOnLostHost)
       THEN /\ running' = IF running = turnOnLostHost THEN None ELSE running
            /\ cutOffUnrun' = (cutOffUnrun \/ (running = turnOnLostHost
                                                /\ EndsAsCutOff(turnOnLostHost)
                                                /\ ranOn[turnOnLostHost] = None))
            /\ interruptedRan' = (interruptedRan \/ (running = turnOnLostHost
                                                      /\ ~EndsAsCutOff(turnOnLostHost)
                                                      /\ ranOn[turnOnLostHost] # None))
            /\ turnOnLostHost' = None
            /\ UNCHANGED taken
       ELSE /\ taken' = IF turnOnLostHost # None /\ Carried(turnOnLostHost)
                         THEN turnOnLostHost ELSE taken
            /\ UNCHANGED <<running, cutOffUnrun, interruptedRan, turnOnLostHost>>
    /\ UNCHANGED <<hostVars, delivering, started, ranOn>>

GlassCutsOffLostHost ==
    /\ following = None
    /\ running # None
    /\ running' = None
    /\ UNCHANGED <<hostVars, replacing, position, turnOnLostHost, following, delivering, started,
                   ranOn, cutOffUnrun, interruptedRan, taken>>

GlassRestarts(newBuild) ==
    /\ following' = None
    /\ delivering' = None
    /\ turnOnLostHost' = running
    /\ taken' = IF Mutant("TakenForgottenOnRestart") THEN None ELSE taken
    /\ compatible' = (compatible /\ ~newBuild)
    /\ replacing' = (replacing /\ ~Mutant("ReplacingKeptInMemory"))
    /\ UNCHANGED <<host, hostUp, hostTurn, pendingEnd, position, running, started, ranOn,
                   cutOffUnrun, interruptedRan>>

Next ==
    \/ YouSendMessage
    \/ HostTakesTurn
    \/ DeliveryFails
    \/ AgentEndsTurn
    \/ GlassSavesJournal
    \/ ConnectionDrops
    \/ SandboxRestartsHost
    \/ GlassFindsOtherProtocol
    \/ GlassStopsOldHost
    \/ GlassStartsNewHost
    \/ GlassFollowsHost
    \/ GlassCutsOffLostHost
    \/ \E newBuild \in BOOLEAN : GlassRestarts(newBuild)

Spec == Init /\ [][Next]_vars

DownHostGetsReplaced == ~hostUp => replacing

RunningTurnIsOnFollowedHost ==
    following = host /\ running # None =>
        running \in {hostTurn, pendingEnd, delivering}

LostHostTurnsEnd ==
    following = host /\ running # None /\ ranOn[running] # None => ranOn[running] = host

CutOffTurnsRan == ~cutOffUnrun

RanTurnsEndCutOff == ~interruptedRan
==============================================================================
