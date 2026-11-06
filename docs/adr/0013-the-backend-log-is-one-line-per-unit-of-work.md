# The backend log is one line per unit of work

`~/.glass/logs/backend.log` used to hold Effect's default text output: about a hundred scattered
warnings such as "Couldn't save an Agent", mostly without saying which Agent, Turn or PR. Answering
"why did this Tour fail?" meant reading the log in order and guessing which lines belonged together.

Now every line is a JSON object. Each unit of work writes one wide event when it ends, with
everything known about it: its outcome, duration, error tag, the IDs it touched, and the runner and
model. Log lines are written as they happen, carrying the `trace_id` of the unit they ran in, so
`jq` can group a unit with its logs. The units are each RPC and HTTP route, a span started with
`root: true` for background work such as a Tour or Agent review, and a Turn, recorded with
`recordUnit` when its end is saved because it starts and ends in different fibers. A cut-off Turn is
recorded again if its real end arrives later, so count Turns by their last line per `turn_id`. Code
deep inside a unit adds fields with `annotateUnit` (`apps/server/src/wideEvents.ts`), whose
`UnitFields` lists what can be queried. `jq` can then answer a question like "failed Turns on pi
this week, by error" from the file a user attaches to a bug report.

The events are Effect spans written by a small tracer, so the existing `Effect.fn` spans cost
nothing and write nothing. Every line carries `source` (`backend`, `agent-host` or `desktop`) and a
`launch_id` for that process, since the Agent host and the desktop app write to the same file. The
backend and the Agent host run through `runMain`, so even the failure that ends one is a JSON line. The
Agent host writes JSON logs but no units of its own: its calls are already part of the backend's
units, and a unit for every journal acknowledgement would bury them.

Fields hold IDs, counts, choices and durations, never message text, prompts, diffs or transcripts,
because users attach this file to bug reports. Errors are recorded as their tag and message only,
since a tagged error's other fields can hold what the user typed. Once a tracer exists, Effect's
HTTP spans record request URLs, so `server.ts` redacts the `token` query parameter.

## Considered options

- **Structured logging without units**: JSON lines with IDs annotated, but still one line per log
  call, so a single failure is still spread across lines that have to be joined.
- **Export spans over OpenTelemetry**: needs a collector the user doesn't run. The question being
  answered is about one person's machine, and one file is enough.
- **Sample the events**: a desktop app writes few enough to keep them all.

## Revisit when

- The log rotates out the events needed to diagnose a report, since it rotates at 5 MB.
- Glass gets a release version worth stamping on each line, since `0.0.0` says nothing yet.
