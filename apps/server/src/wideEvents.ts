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
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/observability"
import { randomUUID } from "node:crypto"
import type { Delivery } from "./ConversationTurns"

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
  readonly prefetched?: boolean
  readonly checkout_ms?: number
  readonly agent_ms?: number
  readonly ending?: string
  readonly delivery?: Delivery
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

const units = new WeakSet<Tracer.Span>()

/** Effect's spans have no end hook, so this patches `end` on the inner tracer's own span. */
const asUnit = (span: Tracer.Span, emit: Emit) => {
  const end = span.end.bind(span)

  span.end = (endTime, exit) => {
    end(endTime, exit)

    emit(
      new Date(Number(endTime / 1_000_000n)).toISOString(),
      {
        ...endingOf(exit),
        event: span.name,
        duration_ms: Math.round(Number(endTime - span.status.startTime) / 1_000_000),
        trace_id: span.traceId,
      },
      span.attributes,
    )
  }

  units.add(span)

  return span
}

const unitOf = (span: Tracer.AnySpan | undefined) => {
  let current = span

  while (current !== undefined && Predicate.isTagged(current, "Span")) {
    if (units.has(current)) return current

    current = Option.getOrUndefined(current.parent)
  }

  return undefined
}

const unitTracer = (emit: Emit) =>
  Layer.effect(Tracer.Tracer)(
    Effect.map(Effect.tracer, (inner) =>
      Tracer.make({
        span: (options) => {
          const span = inner.span(options)

          return options.kind === "server" || options.root ? asUnit(span, emit) : span
        },
        context: inner.context,
      }),
    ),
  )

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

const launchId = randomUUID()

type Source = "backend" | "agent-host"

type Sink = (line: string) => void

const isLoud = (line: UnitLine | LogLine) => line.level === "WARN" || line.level === "ERROR"

const emitter = (source: Source, stdout: Sink, stderr?: Sink): Emit => {
  const launch = {
    source,
    launch_id: launchId,
    platform: `${process.platform}-${process.arch}`,
  }

  return (at, line, extra) => {
    const text = Formatter.formatJson({ at, ...launch, ...Object.fromEntries(extra), ...line })
    const sink = stderr !== undefined && isLoud(line) ? stderr : stdout

    sink(text)
  }
}

const toStdout: Sink = (line) => process.stdout.write(`${line}\n`)

const toStderr: Sink = (line) => process.stderr.write(`${line}\n`)

export const wideEvents = (source: Source, stdout: Sink, stderr?: Sink) => {
  const emit = emitter(source, stdout, stderr)

  return Layer.mergeAll(
    // Replaces the logger set rather than merging: Effect's default text logger would otherwise
    // add non-JSON lines to backend.log (ADR 0012).
    Logger.layer([lineLogger(emit)]),
    unitTracer(emit),
  )
}

export const wideEventsToStdoutAndOtlp = (source: Source) => {
  const resource = {
    serviceName: `glass-${source}`,
    attributes: { "service.instance.id": launchId },
  }

  return OtlpLogger.layerFromConfig({ resource, mergeWithExisting: true }).pipe(
    Layer.provideMerge(wideEvents(source, toStdout, toStderr)),
    Layer.provide(OtlpTracer.layerFromConfig({ resource })),
    Layer.provide(OtlpSerialization.layerProtobuf),
  )
}

export const jsonLogsToStdout = (source: Source) =>
  Logger.layer([lineLogger(emitter(source, toStdout, toStderr))])

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
