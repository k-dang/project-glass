import {
  type Activity,
  ActivityToDo,
  type Image,
  ImageMediaType,
  type ToDoImageSize,
  type ToDoImageUpload,
  ToDo,
  ToDoAdded,
  ToDoDone,
  ToDoError,
  ToDoImage,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { Base64 } from "effect/encoding"
import { SqlClient, type SqlError } from "effect/sql"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { ActivityLog } from "./ActivityLog"
import { ServerConfig } from "./ServerConfig"
import { annotateUnit } from "./wideEvents"

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      title: Schema.String,
      notes: Schema.String,
      done: Schema.BooleanFromBit,
      images: Schema.fromJsonString(Schema.Array(ToDoImage)),
    }),
  ),
)

const decodeChanged = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.Int, title: Schema.String })),
)

const decodeNames = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ file_name: Schema.String })),
)

const decodeInserted = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Int }))

const decodeImageRow = Schema.decodeUnknownEffect(
  Schema.Struct({
    file_name: Schema.String,
    media_type: Schema.String,
    thumbnail_type: Schema.String,
  }),
)

const decodeMediaType = Schema.decodeUnknownEffect(ImageMediaType)

const saveFailed = () => new ToDoError({ message: "Couldn't save your to-do. Try again." })

const loadFailed = () => new ToDoError({ message: "Couldn't load your to-dos. Try again." })

const openFailed = () => new ToDoError({ message: "Couldn't open that image. Try again." })

interface StoredImage {
  readonly mediaType: ImageMediaType
  readonly bytes: Uint8Array
  readonly thumbnail: Uint8Array
  readonly thumbnailMediaType: ImageMediaType
}

const decodeBytes = (encoded: string) => {
  const decoded = Base64.decode(encoded)

  return Result.isFailure(decoded) ? Effect.fail(saveFailed()) : Effect.succeed(decoded.success)
}

const decodeUploads = (images: ReadonlyArray<ToDoImageUpload>) =>
  Effect.forEach(images, (image) =>
    Effect.all({
      mediaType: Effect.succeed(image.mediaType),
      bytes: decodeBytes(image.data),
      thumbnail: decodeBytes(image.thumbnail),
      thumbnailMediaType: Effect.succeed(image.thumbnailMediaType),
    }),
  )

type ToDoList = Effect.Effect<ReadonlyArray<ToDo>, ToDoError>

export const LinkedCompletion = Schema.Struct({
  conversationId: Schema.String,
  completedAt: Schema.DateTimeUtc,
})

export type LinkedCompletion = typeof LinkedCompletion.Type

export class ToDos extends Context.Service<
  ToDos,
  {
    readonly list: () => ToDoList
    readonly watch: () => Stream.Stream<ReadonlyArray<ToDo>, ToDoError>
    readonly add: (title: string, notes: string, images: ReadonlyArray<ToDoImageUpload>) => ToDoList
    readonly edit: (id: number, title: string, notes: string) => ToDoList
    readonly setDone: (id: number, done: boolean) => ToDoList
    readonly remove: (id: number) => ToDoList
    readonly attach: (id: number, images: ReadonlyArray<ToDoImageUpload>) => ToDoList
    readonly removeImage: (id: number) => ToDoList
    readonly readImage: (id: number, size: ToDoImageSize) => Effect.Effect<Image, ToDoError>
    readonly linkConversation: (
      conversationId: string,
      toDoIds: ReadonlyArray<number>,
    ) => Effect.Effect<void, SqlError.SqlError>
    readonly unlinkConversation: (conversationId: string) => Effect.Effect<void, SqlError.SqlError>
    readonly completeLinked: (
      completions: ReadonlyArray<LinkedCompletion>,
    ) => Effect.Effect<void, ToDoError>
  }
>()("@glass/server/ToDos") {
  static readonly layer = Layer.effect(
    ToDos,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const activityLog = yield* ActivityLog
      const fs = yield* FileSystem.FileSystem
      const { dataDirectory } = yield* ServerConfig
      const directory = join(dataDirectory, "to-do-images")
      const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))
      const imagePath = (fileName: string) => join(directory, fileName)
      const thumbnailPath = (fileName: string) => join(directory, `${fileName}.thumb`)

      const read = Effect.gen(function* () {
        const rows = yield* sql`
          SELECT
            id,
            title,
            notes,
            completed_at IS NOT NULL AS done,
            COALESCE(
              (
                SELECT json_group_array(
                  json_object('id', image.id, 'mediaType', image.media_type)
                )
                FROM (
                  SELECT id, media_type
                  FROM to_do_image
                  WHERE to_do_id = to_do.id
                  ORDER BY id
                ) AS image
              ),
              '[]'
            ) AS images
          FROM to_do
          ORDER BY done, completed_at DESC, id
        `

        return (yield* decodeRows(rows)).map((row) => new ToDo(row))
      })

      const list = read.pipe(
        Effect.tapError((cause) => Effect.logWarning("Couldn't load the to-dos", cause)),
        Effect.mapError(loadFailed),
      )

      const published = yield* SubscriptionRef.make(Option.none<ReadonlyArray<ToDo>>())

      const publish = list.pipe(
        Effect.tap((toDos) => SubscriptionRef.set(published, Option.some(toDos))),
      )

      const logSaveFailure = Effect.tapError((cause: unknown) =>
        Effect.logWarning("Couldn't save a to-do", cause),
      )

      const change = <E, R>(statement: Effect.Effect<unknown, E, R>) =>
        statement.pipe(logSaveFailure, Effect.mapError(saveFailed), Effect.andThen(publish))

      const record = <E, R>(
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
        )

      const changeAndRecord = <E, R>(
        statement: Effect.Effect<ReadonlyArray<unknown>, E, R>,
        activity: (toDo: ActivityToDo) => Activity,
      ) => record(statement, activity).pipe(Effect.andThen(publish))

      const deletePaths = (paths: ReadonlyArray<string>) =>
        Effect.forEach(paths, (path) => fs.remove(path, { force: true }).pipe(Effect.ignore), {
          discard: true,
        })

      const writeBytes = (path: string, bytes: Uint8Array, written: Array<string>) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(directory, { recursive: true })
          const temporary = `${path}.${randomUUID()}.tmp`
          written.push(temporary)
          yield* fs.writeFile(temporary, bytes, { mode: 0o600 })
          yield* fs.rename(temporary, path)
          written.push(path)
        }).pipe(Effect.uninterruptible)

      interface PreparedImage {
        readonly fileName: string
        readonly mediaType: ImageMediaType
        readonly thumbnailMediaType: ImageMediaType
      }

      const prepareImages = (images: ReadonlyArray<StoredImage>) => {
        const written: Array<string> = []
        const named = images.map((image) => ({ image, fileName: randomUUID() }))

        return Effect.all(
          named.flatMap(({ image, fileName }) => [
            writeBytes(imagePath(fileName), image.bytes, written),
            writeBytes(thumbnailPath(fileName), image.thumbnail, written),
          ]),
          { concurrency: 4, discard: true },
        ).pipe(
          Effect.onError(() => deletePaths(written)),
          Effect.as(
            named.map(({ image, fileName }): PreparedImage => ({
              fileName,
              mediaType: image.mediaType,
              thumbnailMediaType: image.thumbnailMediaType,
            })),
          ),
        )
      }

      const withImages = <A, E, R>(
        images: ReadonlyArray<StoredImage>,
        use: (prepared: ReadonlyArray<PreparedImage>) => Effect.Effect<A, E, R>,
      ) =>
        Effect.uninterruptibleMask((restore) =>
          restore(prepareImages(images)).pipe(
            Effect.flatMap((prepared) =>
              restore(use(prepared)).pipe(
                Effect.onError(() => forgetImages(prepared.map(({ fileName }) => fileName))),
              ),
            ),
          ),
        )

      const insertImages = (toDoId: number, images: ReadonlyArray<PreparedImage>) =>
        Effect.gen(function* () {
          const createdAt = yield* now

          yield* Effect.forEach(
            images,
            (image) =>
              sql`
              INSERT INTO to_do_image ${sql.insert({
                to_do_id: toDoId,
                file_name: image.fileName,
                media_type: image.mediaType,
                thumbnail_type: image.thumbnailMediaType,
                created_at: createdAt,
              })}
            `,
          )
        })

      const forgetImages = (names: ReadonlyArray<string>) =>
        deletePaths(names.flatMap((name) => [imagePath(name), thumbnailPath(name)]))

      const sweepImages = fs.readDirectory(directory).pipe(
        Effect.orElseSucceed(() => []),
        Effect.flatMap((names) =>
          Effect.gen(function* () {
            const rows = yield* decodeNames(yield* sql`SELECT file_name FROM to_do_image`)
            const live = new Set(rows.flatMap(({ file_name }) => [file_name, `${file_name}.thumb`]))

            yield* deletePaths(
              names.filter((name) => !live.has(name)).map((name) => imagePath(name)),
            )
          }),
        ),
        Effect.ignore,
      )

      yield* sweepImages

      return ToDos.of({
        list: Effect.fn("ToDos.list")(() => list),
        watch: () =>
          SubscriptionRef.changes(published).pipe(
            Stream.mapEffect(Option.match({ onNone: () => list, onSome: Effect.succeed })),
          ),
        add: Effect.fn("ToDos.add")(function* (title, notes, images) {
          const stored = yield* decodeUploads(images)

          return yield* changeAndRecord(
            withImages(stored, (prepared) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  const createdAt = yield* now

                  const created = yield* sql`
                    INSERT INTO to_do ${sql.insert({ title, notes, created_at: createdAt })}
                    RETURNING id, title
                  `

                  const inserted = yield* decodeInserted(created[0])

                  yield* insertImages(inserted.id, prepared)

                  return created
                }),
              ),
            ),
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
            sql.withTransaction(
              Effect.gen(function* () {
                const finished = yield* sql`
                  UPDATE to_do SET completed_at = ${completedAt}
                  WHERE id = ${id} AND completed_at IS NULL
                  RETURNING id, title
                `

                yield* sql`DELETE FROM conversation_to_do WHERE to_do_id = ${id}`

                return finished
              }),
            ),
            (toDo) => ToDoDone.make({ toDo }),
          )
        }),
        remove: Effect.fn("ToDos.remove")((id) =>
          change(
            Effect.gen(function* () {
              const names = yield* sql.withTransaction(
                Effect.gen(function* () {
                  const rows = yield* decodeNames(
                    yield* sql`SELECT file_name FROM to_do_image WHERE to_do_id = ${id}`,
                  )

                  yield* sql`DELETE FROM to_do_image WHERE to_do_id = ${id}`
                  yield* sql`DELETE FROM conversation_to_do WHERE to_do_id = ${id}`
                  yield* sql`DELETE FROM to_do WHERE id = ${id}`

                  return rows
                }),
              )

              yield* forgetImages(names.map(({ file_name }) => file_name))
            }),
          ),
        ),
        attach: Effect.fn("ToDos.attach")(function* (id, images) {
          const stored = yield* decodeUploads(images)

          if (stored.length === 0) return yield* list

          return yield* change(
            withImages(stored, (prepared) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  const found = yield* sql`SELECT id FROM to_do WHERE id = ${id}`

                  if (found.length === 0) return yield* Effect.fail(saveFailed())

                  return yield* insertImages(id, prepared)
                }),
              ),
            ),
          )
        }),
        removeImage: Effect.fn("ToDos.removeImage")((id) =>
          change(
            Effect.gen(function* () {
              const names = yield* sql.withTransaction(
                Effect.gen(function* () {
                  const rows = yield* decodeNames(
                    yield* sql`SELECT file_name FROM to_do_image WHERE id = ${id}`,
                  )

                  yield* sql`DELETE FROM to_do_image WHERE id = ${id}`

                  return rows
                }),
              )

              yield* forgetImages(names.map(({ file_name }) => file_name))
            }),
          ),
        ),
        readImage: Effect.fn("ToDos.readImage")(function* (id, size) {
          const rows = yield* sql<{
            file_name: string
            media_type: string
            thumbnail_type: string
          }>`
            SELECT file_name, media_type, thumbnail_type FROM to_do_image WHERE id = ${id}
          `.pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't open a to-do image", cause)),
            Effect.mapError(openFailed),
          )

          const row = rows[0]

          if (row === undefined) return yield* Effect.fail(openFailed())

          const image = yield* decodeImageRow(row).pipe(Effect.mapError(openFailed))
          const path = size === "full" ? imagePath(image.file_name) : thumbnailPath(image.file_name)

          const bytes = yield* fs.readFile(path).pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't open a to-do image", cause)),
            Effect.mapError(openFailed),
          )

          const mediaType = yield* decodeMediaType(
            size === "full" ? image.media_type : image.thumbnail_type,
          ).pipe(Effect.mapError(openFailed))

          return { mediaType, data: Base64.encode(bytes) }
        }),
        linkConversation: Effect.fn("ToDos.linkConversation")(function* (conversationId, toDoIds) {
          const linkedAt = yield* now

          yield* sql`
            INSERT INTO conversation_to_do (conversation_id, to_do_id, linked_at)
            SELECT ${conversationId}, id, ${linkedAt} FROM to_do
            WHERE completed_at IS NULL AND ${sql.in("id", toDoIds)}
          `
        }),
        unlinkConversation: Effect.fn("ToDos.unlinkConversation")(function* (conversationId) {
          yield* sql`DELETE FROM conversation_to_do WHERE conversation_id = ${conversationId}`
        }),
        completeLinked: Effect.fn("ToDos.completeLinked")(function* (completions) {
          const done = yield* record(
            sql.withTransaction(
              Effect.forEach(completions, ({ conversationId, completedAt }) => {
                const at = DateTime.formatIso(completedAt)

                return sql`
                  UPDATE to_do SET completed_at = ${at}
                  WHERE completed_at IS NULL AND id IN (
                    SELECT to_do_id FROM conversation_to_do
                    WHERE conversation_id = ${conversationId} AND linked_at < ${at}
                  )
                  RETURNING id, title
                `.pipe(
                  Effect.tap(
                    () => sql`
                      DELETE FROM conversation_to_do
                      WHERE conversation_id = ${conversationId} AND linked_at < ${at}
                    `,
                  ),
                )
              }).pipe(Effect.map((rows) => rows.flat())),
            ),
            (toDo) => ToDoDone.make({ toDo }),
          )

          yield* annotateUnit({ to_dos_done: done.length })

          if (done.length > 0) yield* publish
        }),
      })
    }),
  )
}
