# The backend log is one line per unit of work

The backend log used to hold Effect's default text output: about a hundred scattered warnings such
as "Couldn't save an Agent", mostly without saying which Agent, Turn or PR. Answering "why did this
Tour fail?" meant reading the log in order and guessing which lines belonged together.

Now every line is JSON, and each unit of work (an RPC or HTTP route, a background job such as a
Tour, a Turn) writes one wide event when it ends with everything known about it: outcome, duration,
error, the IDs it touched, and the runner and model. Log lines carry their unit's trace ID, so `jq`
can answer "failed Turns on pi this week, by error" from the one file a user attaches to a bug
report. The events are Effect spans written by a small tracer, so existing `Effect.fn` spans write
nothing to the file. The agent host writes logs but no units: its calls are already part of the
backend's, and a unit per journal acknowledgement would bury them.

Because users attach this file to bug reports, fields hold IDs, counts, choices and durations, never
message text, prompts, diffs or transcripts, and errors keep only their tag and message, since a
tagged error's other fields can hold what the user typed.

## Considered options

- **Structured logging without units**: JSON lines with IDs annotated, but still one line per log
  call, so a single failure is still spread across lines that have to be joined.
- **Export spans over OpenTelemetry instead**: needs a collector the user doesn't run. The question
  being answered is about one person's machine, and one file is enough. Developers profiling the
  backend do run one, so when the standard `OTEL_*` variables ask for it every span and log line
  also goes there over OTLP, alongside the file.
- **Sample the events**: a desktop app writes few enough to keep them all.

## Consequences

A Turn starts and ends in different fibers, and one cut off by a crash is recorded again if its
real end arrives later, so count Turns by their last line per `turn_id`.

## Revisit when

- The log rotates out the events needed to diagnose a report, since it rotates at 5 MB.
- Glass gets a release version worth stamping on each line, since `0.0.0` says nothing yet.
