import {
  type AnsweredQuestion,
  type GivenAnswer,
  ListedQuestion,
  OpenQuestion,
  QuestionAnswered,
  QuestionChoice,
  QuestionNotOpen,
  QuestionOutcome,
  QuestionSetAside,
  type QuestionState,
  QuestionWaiting,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { Caller } from "./callers"

export interface AskedQuestion {
  readonly asker: Caller
  readonly question: OpenQuestion
}

const QuestionRow = Schema.Struct({
  id: Schema.String,
  asker: Schema.fromJsonString(Caller),
  question: Schema.String,
  choices: Schema.fromJsonString(Schema.Array(QuestionChoice)),
  asked_at: Schema.DateTimeUtcFromString,
  outcome: Schema.NullOr(Schema.fromJsonString(QuestionOutcome)),
})

type QuestionRow = typeof QuestionRow.Type

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(QuestionRow))

const rowsWhere = (query: Effect.Effect<ReadonlyArray<unknown>, unknown>) =>
  query.pipe(Effect.flatMap(decodeRows), Effect.orDie)

const encodeAsker = Schema.encodeSync(Schema.fromJsonString(Caller))

const encodeChoices = Schema.encodeSync(Schema.fromJsonString(Schema.Array(QuestionChoice)))

const encodeOutcome = Schema.encodeSync(Schema.fromJsonString(QuestionOutcome))

const notifiedThreadOf = (asker: Caller) =>
  Match.value(asker).pipe(
    Match.tagsExhaustive({
      OutsideAgent: () => null,
      Thread: ({ threadId }) => threadId,
      GlobalChat: ({ sessionId }) => sessionId,
    }),
  )

const questionOf = (row: QuestionRow) =>
  OpenQuestion.make({
    id: row.id,
    question: row.question,
    choices: row.choices,
    since: row.asked_at,
  })

const stateOf = ({ outcome }: QuestionRow): QuestionState => outcome ?? QuestionWaiting.make({})

const notOpen = (message: string) => new QuestionNotOpen({ message })

const answeredWith = (row: QuestionRow, { answer }: GivenAnswer) =>
  Match.value(answer).pipe(
    Match.tag("Choice", ({ choice }) =>
      row.choices.some(({ label }) => label === choice)
        ? Option.some(QuestionAnswered.make({ answer: choice, by: "choice" }))
        : Option.none(),
    ),
    Match.tag("Text", ({ text }) =>
      Option.some(QuestionAnswered.make({ answer: text, by: "text" })),
    ),
    Match.exhaustive,
  )

const byThread = (asked: ReadonlyArray<AskedQuestion>) => {
  const grouped = new Map<string, Arr.NonEmptyArray<OpenQuestion>>()

  for (const { asker, question } of asked) {
    if (!Predicate.isTagged(asker, "Thread")) continue

    const own = grouped.get(asker.threadId)

    if (own === undefined) grouped.set(asker.threadId, [question])
    else own.push(question)
  }

  return grouped
}

export class Questions extends Context.Service<
  Questions,
  {
    readonly ask: (
      asker: Caller,
      asked: { readonly question: string; readonly choices: ReadonlyArray<QuestionChoice> },
    ) => Effect.Effect<OpenQuestion>
    readonly answer: <E>(
      answers: Arr.NonEmptyReadonlyArray<GivenAnswer>,
      deliver: (
        asker: Caller,
        answered: Arr.NonEmptyReadonlyArray<AnsweredQuestion>,
      ) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, QuestionNotOpen | E>
    readonly isAsking: (threadId: string) => Effect.Effect<boolean>
    readonly setAside: (questionId: string) => Effect.Effect<void, QuestionNotOpen>
    readonly readAnswer: (
      questionId: string,
      agentId: string,
    ) => Effect.Effect<Option.Option<QuestionState>>
    readonly unread: (agentId: string) => Effect.Effect<ReadonlyArray<ListedQuestion>>
    readonly open: Stream.Stream<ReadonlyArray<AskedQuestion>>
    readonly openByThread: Stream.Stream<
      ReadonlyMap<string, Arr.NonEmptyReadonlyArray<OpenQuestion>>
    >
    readonly setAsideUntold: (threadId: string) => Effect.Effect<ReadonlyArray<OpenQuestion>>
    readonly markTold: (questionIds: ReadonlyArray<string>) => Effect.Effect<void>
    readonly forgetAgent: (agentId: string) => Effect.Effect<void>
  }
>()("@glass/server/Questions") {
  static readonly layer = Layer.effect(
    Questions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql`UPDATE question SET outcome = NULL, delivering = 0 WHERE delivering = 1`.pipe(
        Effect.orDie,
      )

      const readOpen = rowsWhere(
        sql`
          SELECT * FROM question WHERE outcome IS NULL OR delivering = 1 ORDER BY asked_at, rowid
        `,
      ).pipe(
        Effect.map((rows) => rows.map((row) => ({ asker: row.asker, question: questionOf(row) }))),
      )

      const open = yield* SubscriptionRef.make(yield* readOpen)
      const refresh = readOpen.pipe(Effect.flatMap((asked) => SubscriptionRef.set(open, asked)))

      const refreshIfAny = (changed: ReadonlyArray<unknown>) =>
        changed.length === 0 ? Effect.void : refresh

      const ask = Effect.fn("Questions.ask")(function* (
        asker: Caller,
        asked: { readonly question: string; readonly choices: ReadonlyArray<QuestionChoice> },
      ) {
        const question = OpenQuestion.make({
          id: randomUUID(),
          question: asked.question,
          choices: [...asked.choices],
          since: yield* DateTime.now,
        })

        yield* sql`
          INSERT INTO question ${sql.insert({
            id: question.id,
            asker: encodeAsker(asker),
            agent_id: Predicate.isTagged(asker, "OutsideAgent") ? asker.agentId : null,
            notify_thread_id: notifiedThreadOf(asker),
            question: question.question,
            choices: encodeChoices(question.choices),
            asked_at: DateTime.formatIso(question.since),
          })}
        `.pipe(Effect.orDie)
        yield* refresh

        return question
      })

      const answer = Effect.fn("Questions.answer")(function* <E>(
        answers: Arr.NonEmptyReadonlyArray<GivenAnswer>,
        deliver: (
          asker: Caller,
          answered: Arr.NonEmptyReadonlyArray<AnsweredQuestion>,
        ) => Effect.Effect<void, E>,
      ) {
        const ids = answers.map(({ questionId }) => questionId)

        if (new Set(ids).size !== ids.length) yield* notOpen("Each Question takes one answer.")

        const answered = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* rowsWhere(
                sql`SELECT * FROM question WHERE outcome IS NULL AND ${sql.in("id", ids)}`,
              )

              const pairs = yield* Effect.forEach(answers, (given) => {
                const row = rows.find(({ id }) => id === given.questionId)

                if (row === undefined)
                  return Effect.fail(notOpen("That Question was already answered or set aside."))

                return Option.match(answeredWith(row, given), {
                  onNone: () => Effect.fail(notOpen("That choice isn't one the agent offered.")),
                  onSome: (outcome) => Effect.succeed({ row, outcome }),
                })
              })

              const [first, ...rest] = pairs

              if (first === undefined) return yield* notOpen("Answer at least one Question.")

              const asker = encodeAsker(first.row.asker)

              if (rest.some(({ row }) => encodeAsker(row.asker) !== asker))
                return yield* notOpen("Answers sent together go to one agent.")

              yield* Effect.forEach(
                pairs,
                ({ row, outcome }) => sql`
                  UPDATE question SET outcome = ${encodeOutcome(outcome)}, delivering = 1
                  WHERE id = ${row.id}
                `,
                { discard: true },
              ).pipe(Effect.orDie)

              return {
                asker: first.row.asker,
                answered: Arr.map(
                  [first, ...rest] as const,
                  ({ row, outcome }): AnsweredQuestion => ({
                    questionId: row.id,
                    question: row.question,
                    answer: outcome.answer,
                  }),
                ),
              }
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die))

        const answeredIds = sql.in(
          "id",
          answered.answered.map(({ questionId }) => questionId),
        )

        yield* Effect.suspend(() => deliver(answered.asker, answered.answered)).pipe(
          Effect.onExit((exit) =>
            (Exit.isSuccess(exit)
              ? sql`
                  UPDATE question
                  SET delivering = 0, told = CASE WHEN agent_id IS NULL THEN 1 ELSE told END
                  WHERE ${answeredIds}
                `
              : sql`
                  UPDATE question SET outcome = NULL, delivering = 0, told = 0
                  WHERE ${answeredIds}
                `
            ).pipe(Effect.orDie),
          ),
          Effect.ensuring(refresh),
        )
      }, Effect.uninterruptible)

      const setAside = Effect.fn("Questions.setAside")(function* (questionId: string) {
        const settled = yield* sql`
          UPDATE question SET outcome = ${encodeOutcome(QuestionSetAside.make({}))}
          WHERE id = ${questionId} AND outcome IS NULL
          RETURNING id
        `.pipe(Effect.orDie)

        if (settled.length === 0) yield* notOpen("That Question was already answered or set aside.")

        yield* refresh
      })

      const markRead = (rows: ReadonlyArray<QuestionRow>) => {
        const settled = rows.flatMap(({ id, outcome }) => (outcome === null ? [] : [id]))

        return settled.length === 0
          ? Effect.void
          : sql`UPDATE question SET told = 1 WHERE ${sql.in("id", settled)}`.pipe(
              Effect.orDie,
              Effect.asVoid,
            )
      }

      const readAnswer = Effect.fn("Questions.readAnswer")(function* (
        questionId: string,
        agentId: string,
      ) {
        const rows = yield* rowsWhere(
          sql`SELECT * FROM question WHERE id = ${questionId} AND agent_id = ${agentId}`,
        )

        yield* markRead(rows)

        return Option.map(Arr.head(rows), stateOf)
      })

      const unread = Effect.fn("Questions.unread")(function* (agentId: string) {
        const rows = yield* rowsWhere(sql`
          SELECT * FROM question WHERE agent_id = ${agentId} AND told = 0
          ORDER BY asked_at, rowid
        `)

        yield* markRead(rows)

        return rows.map((row) =>
          ListedQuestion.make({
            id: row.id,
            question: row.question,
            since: row.asked_at,
            state: stateOf(row),
          }),
        )
      })

      return Questions.of({
        ask,
        answer,
        isAsking: (threadId) =>
          SubscriptionRef.get(open).pipe(
            Effect.map((asked) => asked.some(({ asker }) => notifiedThreadOf(asker) === threadId)),
          ),
        setAside,
        readAnswer,
        unread,
        open: SubscriptionRef.changes(open),
        openByThread: SubscriptionRef.changes(open).pipe(Stream.map(byThread)),
        setAsideUntold: (threadId) =>
          rowsWhere(sql`
            SELECT * FROM question
            WHERE notify_thread_id = ${threadId} AND told = 0 AND outcome IS NOT NULL
              AND delivering = 0
            ORDER BY asked_at, rowid
          `).pipe(Effect.map((rows) => rows.map(questionOf))),
        markTold: (questionIds) =>
          questionIds.length === 0
            ? Effect.void
            : sql`UPDATE question SET told = 1 WHERE ${sql.in("id", questionIds)}`.pipe(
                Effect.orDie,
                Effect.asVoid,
              ),
        forgetAgent: (agentId) =>
          sql`
            DELETE FROM question WHERE agent_id = ${agentId} AND outcome IS NULL RETURNING id
          `.pipe(Effect.orDie, Effect.flatMap(refreshIfAny)),
      })
    }),
  )
}
