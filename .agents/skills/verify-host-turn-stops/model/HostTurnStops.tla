---------------------------- MODULE HostTurnStops ----------------------------
EXTENDS Naturals

CONSTANTS MaxTurns, MaxSteers, Broken

Steers == 1..MaxSteers

VARIABLES
    loop,
    turn,
    inTurn,
    consumed,
    shown,
    returned,
    requeued,
    over,
    gate,
    gateSteers,
    overBudgetStops,
    journalFull,
    cancelling

vars == <<loop, turn, inTurn, consumed, shown, returned, requeued, over, gate, gateSteers,
          overBudgetStops, journalFull, cancelling>>

steerVars == <<inTurn, consumed, shown, returned, requeued, over>>

Mutant(name) == name \in Broken

Init ==
    /\ loop = "idle"
    /\ turn = 0
    /\ inTurn = [s \in Steers |-> 0]
    /\ consumed = [s \in Steers |-> FALSE]
    /\ shown = [s \in Steers |-> FALSE]
    /\ returned = [s \in Steers |-> FALSE]
    /\ requeued = [s \in Steers |-> FALSE]
    /\ over = [s \in Steers |-> FALSE]
    /\ gate = 0
    /\ gateSteers = {}
    /\ overBudgetStops = 0
    /\ journalFull = FALSE
    /\ cancelling = {}

Current(s) == inTurn[s] = turn /\ turn > 0 /\ ~over[s]

InState == {s \in Steers : Current(s) /\ ~shown[s]}

Cancellable ==
    IF Mutant("StopReturnsEverySteer") THEN InState
    ELSE {s \in InState : ~consumed[s] /\ ~returned[s]}

AgentStartsTurn ==
    /\ loop = "idle"
    /\ turn < MaxTurns
    /\ loop' = "running"
    /\ turn' = turn + 1
    /\ gate' = 0
    /\ gateSteers' = {}
    /\ overBudgetStops' = 0
    /\ UNCHANGED <<steerVars, journalFull, cancelling>>

YouSteer(s) ==
    /\ loop = "running"
    /\ inTurn[s] = 0
    /\ inTurn' = [inTurn EXCEPT ![s] = turn]
    /\ UNCHANGED <<loop, turn, consumed, shown, returned, requeued, over, gate, gateSteers,
                   overBudgetStops, journalFull, cancelling>>

AgentReadsSteer(s) ==
    /\ loop # "idle"
    /\ Current(s)
    /\ ~consumed[s]
    /\ ~returned[s]
    /\ s \notin cancelling
    /\ consumed' = [consumed EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<loop, turn, inTurn, shown, returned, requeued, over, gate, gateSteers,
                   overBudgetStops, journalFull, cancelling>>

AgentAnswersSteer(s) ==
    /\ loop # "idle"
    /\ Current(s)
    /\ consumed[s]
    /\ ~shown[s]
    /\ shown' = [shown EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<loop, turn, inTurn, consumed, returned, requeued, over, gate, gateSteers,
                   overBudgetStops, journalFull, cancelling>>

Return(set) == returned' = [s \in Steers |-> returned[s] \/ s \in set]

YouStop ==
    /\ loop # "idle"
    /\ cancelling = {}
    /\ loop' = "stopping"
    /\ cancelling' = Cancellable
    /\ UNCHANGED <<turn, steerVars, gate, gateSteers, overBudgetStops, journalFull>>

Held == {s \in cancelling : Current(s) /\ ~shown[s]}

StopReceipt ==
    /\ cancelling # {}
    /\ Return(Held)
    /\ requeued' = [s \in Steers |-> requeued[s] \/ s \in Held]
    /\ cancelling' = {}
    /\ UNCHANGED <<loop, turn, inTurn, consumed, shown, over, gate, gateSteers, overBudgetStops,
                   journalFull>>

JournalFills ==
    /\ ~journalFull
    /\ journalFull' = TRUE
    /\ UNCHANGED <<loop, turn, steerVars, gate, gateSteers, overBudgetStops, cancelling>>

JournalDrains ==
    /\ journalFull
    /\ journalFull' = FALSE
    /\ UNCHANGED <<loop, turn, steerVars, gate, gateSteers, overBudgetStops, cancelling>>

OverBudgetStop ==
    /\ journalFull
    /\ loop # "idle"
    /\ gate = 0 \/ Mutant("NoOverBudgetGate")
    /\ overBudgetStops < 2
    /\ gate' = turn
    /\ overBudgetStops' = overBudgetStops + 1
    /\ loop' = "stopping"
    /\ gateSteers' = gateSteers \cup (Cancellable \ cancelling)
    /\ Return(Cancellable \ cancelling)
    /\ UNCHANGED <<turn, inTurn, consumed, shown, requeued, over, journalFull, cancelling>>

AgentEndsTurn(exits) ==
    /\ loop # "idle"
    /\ loop' = "idle"
    /\ LET natural == loop = "running"
           carried == IF gate = turn /\ ~Mutant("EndDropsStopSteers") THEN gateSteers ELSE {}
           hidesStopSteers == (~natural /\ Mutant("EndHidesStopSteers"))
                              \/ (exits /\ Mutant("ExitHidesSteers"))
       IN /\ shown' = [s \in Steers |-> shown[s] \/ (s \in InState /\ ~returned[s] /\ ~hidesStopSteers)]
          /\ requeued' = [s \in Steers |-> requeued[s] \/ s \in carried]
    /\ over' = [s \in Steers |-> over[s] \/ (inTurn[s] = turn /\ turn > 0)]
    /\ gate' = 0
    /\ gateSteers' = {}
    /\ UNCHANGED <<turn, inTurn, consumed, returned, overBudgetStops, journalFull, cancelling>>

Next ==
    \/ AgentStartsTurn
    \/ \E s \in Steers : YouSteer(s) \/ AgentReadsSteer(s) \/ AgentAnswersSteer(s)
    \/ YouStop
    \/ StopReceipt
    \/ JournalFills
    \/ JournalDrains
    \/ OverBudgetStop
    \/ \E exits \in BOOLEAN : AgentEndsTurn(exits)

Spec == Init /\ [][Next]_vars

OneOverBudgetStopPerTurn == overBudgetStops <= 1

NoSteerTwice == \A s \in Steers : ~(shown[s] /\ requeued[s])


ReturnedSteersComeBack == \A s \in Steers : over[s] /\ returned[s] => requeued[s]

NoSteerLost == \A s \in Steers : over[s] => shown[s] \/ requeued[s]
==============================================================================
