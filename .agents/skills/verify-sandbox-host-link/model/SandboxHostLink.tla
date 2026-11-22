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
    cutOffUnrun, ranMisended,
    accepted,
    taken,
    savedTaken

vars == <<host, hostUp, compatible, hostTurn, pendingEnd, replacing, position, turnOnLostHost,
          following, running, delivering, started, ranOn, cutOffUnrun, ranMisended, accepted, taken, savedTaken>>

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
    /\ ranMisended = FALSE
    /\ accepted = None
    /\ taken = None
    /\ savedTaken = None

YouSendMessage ==
    /\ running = None
    /\ started < MaxTurns
    /\ started' = started + 1
    /\ running' = started + 1
    /\ delivering' = started + 1
    /\ UNCHANGED <<hostVars, replacing, position, turnOnLostHost, following, ranOn, cutOffUnrun, ranMisended,
                   accepted, taken, savedTaken>>

HostTakesTurn ==
    /\ delivering # None
    /\ following = host
    /\ hostTurn = None
    /\ accepted = None
    /\ IF running = delivering
       THEN /\ hostTurn' = delivering
            /\ ranOn' = [ranOn EXCEPT ![delivering] = host]
            /\ accepted' = delivering
            /\ UNCHANGED delivering
       ELSE /\ delivering' = None
            /\ UNCHANGED <<hostTurn, ranOn, accepted>>
    /\ UNCHANGED <<host, hostUp, compatible, pendingEnd, replacing, position, turnOnLostHost, following,
                   running, started, cutOffUnrun, ranMisended, taken, savedTaken>>

GlassGetsAcceptance ==
    /\ accepted # None
    /\ following = host
    /\ delivering = accepted
    /\ delivering' = None
    /\ accepted' = None
    /\ taken' = accepted
    /\ UNCHANGED <<hostVars, replacing, position, turnOnLostHost, following, running, started, ranOn,
                   cutOffUnrun, ranMisended, savedTaken>>

GlassSavesTaken ==
    /\ savedTaken # taken
    /\ savedTaken' = taken
    /\ UNCHANGED <<hostVars, replacing, position, turnOnLostHost, following, running, delivering,
                   started, ranOn, cutOffUnrun, ranMisended, accepted, taken>>

DeliveryFails ==
    /\ delivering # None
    /\ delivering' = None
    /\ accepted' = None
    /\ running' = IF running = delivering THEN None ELSE running
    /\ ranMisended' = (ranMisended \/ (running = delivering /\ ranOn[delivering] # None))
    /\ UNCHANGED <<hostVars, replacing, position, turnOnLostHost, following, started, ranOn,
                   cutOffUnrun, taken, savedTaken>>

AgentEndsTurn ==
    /\ hostTurn # None
    /\ pendingEnd = None
    /\ pendingEnd' = hostTurn
    /\ hostTurn' = None
    /\ UNCHANGED <<host, hostUp, compatible, replacing, position, turnOnLostHost, following,
                   running, delivering, started, ranOn, cutOffUnrun, ranMisended, accepted, taken, savedTaken>>

GlassSavesJournal ==
    /\ following = host
    /\ pendingEnd # None
    /\ running' = IF running = pendingEnd THEN None ELSE running
    /\ pendingEnd' = None
    /\ UNCHANGED <<host, hostUp, compatible, hostTurn, replacing, position, turnOnLostHost, following,
                   delivering, started, ranOn, cutOffUnrun, ranMisended, accepted, taken, savedTaken>>

Release ==
    /\ turnOnLostHost' =
           IF Mutant("ReleaseKeepsOldTurn") THEN turnOnLostHost
           ELSE IF running # None /\ running = taken THEN running
           ELSE None
    /\ following' = None
    /\ accepted' = None

ConnectionDrops ==
    /\ following # None
    /\ Release
    /\ UNCHANGED <<hostVars, replacing, position, running, delivering, started, ranOn,
                   cutOffUnrun, ranMisended, taken, savedTaken>>

SandboxRestartsHost ==
    /\ hostUp
    /\ host < MaxHosts
    /\ host' = host + 1
    /\ UNCHANGED hostUp
    /\ compatible' = TRUE
    /\ hostTurn' = None
    /\ pendingEnd' = None
    /\ IF following # None THEN Release ELSE UNCHANGED <<turnOnLostHost, following, accepted>>
    /\ UNCHANGED <<replacing, position, running, delivering, started, ranOn, cutOffUnrun, ranMisended, taken, savedTaken>>

GlassFindsOtherProtocol ==
    /\ following = None
    /\ ~compatible
    /\ ~replacing
    /\ replacing' = TRUE
    /\ UNCHANGED <<hostVars, position, turnOnLostHost, following, running, delivering, started,
                   ranOn, cutOffUnrun, ranMisended, accepted, taken, savedTaken>>

GlassStopsOldHost ==
    /\ following = None
    /\ replacing
    /\ hostUp
    /\ hostUp' = FALSE
    /\ hostTurn' = None
    /\ pendingEnd' = None
    /\ UNCHANGED <<host, compatible, replacing, position, turnOnLostHost, following, running,
                   delivering, started, ranOn, cutOffUnrun, ranMisended, accepted, taken, savedTaken>>

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
                   ranOn, cutOffUnrun, ranMisended, accepted, taken, savedTaken>>

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
            /\ ranMisended' = (ranMisended \/ (running = turnOnLostHost
                                                      /\ ~EndsAsCutOff(turnOnLostHost)
                                                      /\ ranOn[turnOnLostHost] # None))
            /\ turnOnLostHost' = None
            /\ UNCHANGED taken
       ELSE /\ taken' = IF turnOnLostHost # None /\ Carried(turnOnLostHost)
                         THEN turnOnLostHost ELSE taken
            /\ UNCHANGED <<running, cutOffUnrun, ranMisended, turnOnLostHost>>
    /\ UNCHANGED <<hostVars, delivering, started, ranOn, accepted, savedTaken>>

GlassCutsOffLostHost ==
    /\ following = None
    /\ running # None
    /\ running' = None
    /\ UNCHANGED <<hostVars, replacing, position, turnOnLostHost, following, delivering, started,
                   ranOn, cutOffUnrun, ranMisended, accepted, taken, savedTaken>>

GlassRestarts(newBuild) ==
    /\ following' = None
    /\ delivering' = None
    /\ turnOnLostHost' = running
    /\ accepted' = None
    /\ taken' = IF Mutant("TakenForgottenOnRestart") THEN None ELSE savedTaken
    /\ compatible' = (compatible /\ ~newBuild)
    /\ replacing' = (replacing /\ ~Mutant("ReplacingKeptInMemory"))
    /\ UNCHANGED <<host, hostUp, hostTurn, pendingEnd, position, running, started, ranOn,
                   cutOffUnrun, ranMisended, savedTaken>>

Next ==
    \/ YouSendMessage
    \/ HostTakesTurn
    \/ GlassGetsAcceptance
    \/ GlassSavesTaken
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
    following = host /\ running # None /\ running # delivering /\ ranOn[running] # None =>
        ranOn[running] = host

CutOffTurnsRan == ~cutOffUnrun

RanTurnsEndCutOff == ~ranMisended
==============================================================================
