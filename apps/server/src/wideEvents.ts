import { NodeRuntime } from "@effect/platform-node"
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Effect,
  Exit,
  Formatter,
  Layer,
  Logger,
  Option,
  Predicate,
  Tracer,
} from "effect"
import { randomUUID } from "node:crypto"

/**
 * Fields hold IDs, counts, choices and durations. Never put message text, prompts, diffs,
 * transcripts or credentials in them: users attach `backend.log` to bug reports.
 */
export interface UnitFields {
  readonly pr?: string
  readonly head?: string
  readonly agent_id?: string
  readonly turn_id?: string
  readonly engine?: string | null
  readonly model?: string | null
  readonly effort?: string | null
  readonly sandbox_provider?: string | null
  readonly clone?: "new" | "existing"
  readonly checkout_ms?: number
  readonly agent_ms?: number
  readonly ending?: string
  readonly tool_calls?: number
  readonly failed_tool_calls?: number
}

type DurationField = "checkout_ms" | "agent_ms"

interface Ending {
  readonly level: "INFO" | "WARN" | "ERROR"
  readonly outcome: "success" | "failure" | "interrupted"
  readonly error: { readonly tag: string; readonly message: string } | undefined
}

const endingOf = (exit: Exit.Exit<unknown, unknown>): Ending => {
  if (Exit.isSuccess(exit)) return { level: "INFO", outcome: "success", error: undefined }

  const error = Cause.findErrorOption(exit.cause)

  if (Option.isSome(error)) {
    const value = error.value

    return {
      level: "WARN",
      outcome: "failure",
      error: {
        tag: Predicate.hasProperty(value, "_tag") ? String(value._tag) : "Unknown",
        message: Predicate.hasProperty(value, "message") ? String(value.message) : String(value),
      },
    }
  }

  return Cause.hasDies(exit.cause)
    ? {
        level: "ERROR",
        outcome: "failure",
        error: { tag: "Defect", message: Cause.pretty(exit.cause) },
      }
    : { level: "INFO", outcome: "interrupted", error: undefined }
}

interface UnitLine extends Ending {
  readonly event: string
  readonly duration_ms: number
  readonly trace_id: string
}

interface LogLine {
  readonly level: string
  readonly message: unknown
  readonly details: ReadonlyArray<unknown> | undefined
  readonly cause: string | undefined
  readonly trace_id: string | undefined
}

type Emit = (
  at: string,
  line: UnitLine | LogLine,
  extra: Iterable<readonly [string, unknown]>,
) => void

type SpanInit = ConstructorParameters<typeof Tracer.NativeSpan>[0]

class UnitSpan extends Tracer.NativeSpan {
  readonly #emit: Emit

  constructor(options: SpanInit, emit: Emit) {
    super(options)
    this.#emit = emit
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    super.end(endTime, exit)

    this.#emit(
      new Date(Number(endTime / 1_000_000n)).toISOString(),
      {
        ...endingOf(exit),
        event: this.name,
        duration_ms: Math.round(Number(endTime - this.startTime) / 1_000_000),
        trace_id: this.traceId,
      },
      this.attributes,
    )
  }
}

const unitOf = (span: Tracer.AnySpan | undefined): UnitSpan | undefined => {
  let current = span

  while (current !== undefined && !(current instanceof UnitSpan))
    current = Predicate.isTagged(current, "Span")
      ? Option.getOrUndefined(current.parent)
      : undefined

  return current
}

const unitTracer = (emit: Emit) =>
  Tracer.make({
    span: (options) =>
      options.kind === "server" || options.root
        ? new UnitSpan(options, emit)
        : new Tracer.NativeSpan(options),
  })

const lineLogger = (emit: Emit) =>
  Logger.make((options) => {
    const { message, level, timestamp, cause, annotations } = Logger.formatStructured.log(options)
    const [text, ...details] = Array.isArray(message) ? message : [message]

    emit(
      timestamp,
      {
        level,
        message: text,
        details: details.length === 0 ? undefined : details,
        cause,
        trace_id: options.fiber.cache.span?.traceId,
      },
      Object.entries(annotations),
    )
  })

type Source = "backend" | "agent-host"

const emitter = (source: Source, write: (line: string) => void): Emit => {
  const launch = {
    source,
    launch_id: randomUUID(),
    platform: `${process.platform}-${process.arch}`,
  }

  return (at, line, extra) =>
    write(Formatter.formatJson({ at, ...launch, ...Object.fromEntries(extra), ...line }))
}

const toStdout = (line: string) => process.stdout.write(`${line}\n`)

export const wideEvents = (source: Source, write: (line: string) => void) => {
  const emit = emitter(source, write)

  return Layer.mergeAll(
    Logger.layer([lineLogger(emit)]),
    Layer.succeed(Tracer.Tracer)(unitTracer(emit)),
  )
}

export const wideEventsToStdout = (source: Source) => wideEvents(source, toStdout)

export const jsonLogsToStdout = (source: Source) =>
  Logger.layer([lineLogger(emitter(source, toStdout))])

/**
 * Runs a process's main effect with `output` providing its logger, so the failure that ends it is
 * a JSON line too: `NodeRuntime.runMain`'s own report would use Effect's default text logger.
 */
export const runMain =
  (output: Layer.Layer<never>) =>
  <A, E>(main: Effect.Effect<A, E>) =>
    main.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("Stopped", cause),
      ),
      Effect.provide(output),
      NodeRuntime.runMain({ disableErrorReporting: true }),
    )

/** Does nothing outside a unit of work. */
export const annotateUnit = (fields: UnitFields) =>
  Effect.withFiber((fiber) =>
    Effect.sync(() => {
      const unit = unitOf(fiber.cache.span)

      for (const [key, value] of Object.entries(fields)) unit?.attribute(key, value)
    }),
  )

export const recordDuration =
  (field: DurationField) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Clock.currentTimeMillis, (start) =>
      effect.pipe(
        Effect.onExit(() =>
          Effect.flatMap(Clock.currentTimeMillis, (end) => {
            const fields: Pick<UnitFields, DurationField> = { [field]: end - start }

            return annotateUnit(fields)
          }),
        ),
      ),
    )

const nanos = (at: DateTime.DateTime) => BigInt(DateTime.toEpochMillis(at)) * 1_000_000n

export const recordUnit = (
  name: string,
  unit: {
    readonly startedAt: DateTime.DateTime
    readonly endedAt: DateTime.DateTime
    readonly exit: Exit.Exit<unknown, unknown>
    readonly fields: UnitFields
  },
) =>
  Effect.withFiber((fiber) =>
    Effect.sync(() => {
      const span = fiber.getRef(Tracer.Tracer).span({
        name,
        parent: Option.none(),
        annotations: Context.empty(),
        links: [],
        startTime: nanos(unit.startedAt),
        kind: "internal",
        root: true,
        sampled: true,
      })

      for (const [key, value] of Object.entries(unit.fields)) span.attribute(key, value)
      span.end(nanos(unit.endedAt), unit.exit)
    }),
  )
