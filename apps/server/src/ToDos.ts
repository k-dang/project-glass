import { type Activity, ActivityToDo, ToDo, ToDoAdded, ToDoDone, ToDoError } from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ActivityLog } from "./ActivityLog"

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      title: Schema.String,
      notes: Schema.String,
      done: Schema.BooleanFromBit,
    }),
  ),
)

const decodeChanged = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.Int, title: Schema.String })),
)

const saveFailed = () => new ToDoError({ message: "Couldn't save your to-do. Try again." })

const loadFailed = () => new ToDoError({ message: "Couldn't load your to-dos. Try again." })

type ToDoList = Effect.Effect<ReadonlyArray<ToDo>, ToDoError>

export class ToDos extends Context.Service<
  ToDos,
  {
    readonly list: () => ToDoList
    readonly add: (title: string) => ToDoList
    readonly edit: (id: number, title: string, notes: string) => ToDoList
    readonly setDone: (id: number, done: boolean) => ToDoList
    readonly remove: (id: number) => ToDoList
  }
>()("@glass/server/ToDos") {
  static readonly layer = Layer.effect(
    ToDos,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const activityLog = yield* ActivityLog
      const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))

      const read = Effect.gen(function* () {
        const rows = yield* sql`
          SELECT id, title, notes, completed_at IS NOT NULL AS done
          FROM to_do
          ORDER BY done, completed_at DESC, id
        `

        return (yield* decodeRows(rows)).map((row) => new ToDo(row))
      })

      const list = read.pipe(
        Effect.tapError((cause) => Effect.logWarning("Couldn't load the to-dos", cause)),
        Effect.mapError(loadFailed),
      )

      const logSaveFailure = Effect.tapError((cause: unknown) =>
        Effect.logWarning("Couldn't save a to-do", cause),
      )

      const change = <E, R>(statement: Effect.Effect<unknown, E, R>) =>
        statement.pipe(logSaveFailure, Effect.mapError(saveFailed), Effect.andThen(list))

      const changeAndRecord = <E, R>(
        statement: Effect.Effect<ReadonlyArray<unknown>, E, R>,
        activity: (toDo: ActivityToDo) => Activity,
      ) =>
        statement.pipe(
          Effect.flatMap(decodeChanged),
          logSaveFailure,
          Effect.mapError(saveFailed),
          Effect.tap(
            Effect.forEach((changed) => activityLog.record(activity(new ActivityToDo(changed)))),
          ),
          Effect.andThen(list),
        )

      return ToDos.of({
        list: Effect.fn("ToDos.list")(() => list),
        add: Effect.fn("ToDos.add")(function* (title) {
          const createdAt = yield* now

          return yield* changeAndRecord(
            sql`
              INSERT INTO to_do ${sql.insert({ title, notes: "", created_at: createdAt })}
              RETURNING id, title
            `,
            (toDo) => ToDoAdded.make({ toDo }),
          )
        }),
        edit: Effect.fn("ToDos.edit")((id, title, notes) =>
          change(sql`UPDATE to_do SET ${sql.update({ title, notes })} WHERE id = ${id}`),
        ),
        setDone: Effect.fn("ToDos.setDone")(function* (id, done) {
          if (!done)
            return yield* change(sql`UPDATE to_do SET completed_at = NULL WHERE id = ${id}`)

          const completedAt = yield* now

          return yield* changeAndRecord(
            sql`
              UPDATE to_do SET completed_at = ${completedAt}
              WHERE id = ${id} AND completed_at IS NULL
              RETURNING id, title
            `,
            (toDo) => ToDoDone.make({ toDo }),
          )
        }),
        remove: Effect.fn("ToDos.remove")((id) => change(sql`DELETE FROM to_do WHERE id = ${id}`)),
      })
    }),
  )
}
