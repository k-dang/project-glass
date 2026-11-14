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
import { Context, DateTime, Effect, FileSystem, Layer, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { ActivityLog } from "./ActivityLog"
import { ServerConfig } from "./ServerConfig"

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

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.Int })))

const decodeInserted = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Int }))

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

export class ToDos extends Context.Service<
  ToDos,
  {
    readonly list: () => ToDoList
    readonly add: (title: string, notes: string, images: ReadonlyArray<ToDoImageUpload>) => ToDoList
    readonly edit: (id: number, title: string, notes: string) => ToDoList
    readonly setDone: (id: number, done: boolean) => ToDoList
    readonly remove: (id: number) => ToDoList
    readonly attach: (id: number, images: ReadonlyArray<ToDoImageUpload>) => ToDoList
    readonly removeImage: (id: number) => ToDoList
    readonly readImage: (id: number, size: ToDoImageSize) => Effect.Effect<Image, ToDoError>
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
      const imageFile = (id: number) => join(directory, String(id))
      const thumbnailFile = (id: number) => join(directory, `${id}.thumb`)

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

      const deletePaths = (paths: ReadonlyArray<string>) =>
        Effect.forEach(paths, (path) => fs.remove(path, { force: true }).pipe(Effect.ignore), {
          discard: true,
        })

      const writeBytes = (path: string, bytes: Uint8Array, written: Array<string>) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(path), { recursive: true })
          const temporary = `${path}.${randomUUID()}.tmp`
          written.push(temporary)
          yield* fs.writeFile(temporary, bytes, { mode: 0o600 })
          yield* fs.rename(temporary, path)
          written.push(path)
        })

      const storeImages = (
        toDoId: number,
        images: ReadonlyArray<StoredImage>,
        written: Array<string>,
      ) =>
        Effect.forEach(images, (image) =>
          Effect.gen(function* () {
            const createdAt = yield* now

            const inserted = yield* decodeInserted(
              (yield* sql`
                INSERT INTO to_do_image ${sql.insert({
                  to_do_id: toDoId,
                  media_type: image.mediaType,
                  thumbnail_type: image.thumbnailMediaType,
                  created_at: createdAt,
                })}
                RETURNING id
              `)[0],
            )

            yield* writeBytes(imageFile(inserted.id), image.bytes, written)
            yield* writeBytes(thumbnailFile(inserted.id), image.thumbnail, written)
          }),
        )

      const withImages = <A, E, R>(
        statement: (written: Array<string>) => Effect.Effect<A, E, R>,
      ) => {
        const written: Array<string> = []

        return statement(written).pipe(Effect.tapError(() => deletePaths(written)))
      }

      const removeFiles = (id: number) =>
        Effect.all([
          fs.remove(imageFile(id), { force: true }),
          fs.remove(thumbnailFile(id), { force: true }),
        ]).pipe(Effect.asVoid)

      return ToDos.of({
        list: Effect.fn("ToDos.list")(() => list),
        add: Effect.fn("ToDos.add")(function* (title, notes, images) {
          const stored = yield* decodeUploads(images)
          const createdAt = yield* now

          return yield* changeAndRecord(
            withImages((written) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  const created = yield* sql`
                    INSERT INTO to_do ${sql.insert({ title, notes, created_at: createdAt })}
                    RETURNING id, title
                  `

                  const inserted = yield* decodeInserted(created[0])

                  yield* storeImages(inserted.id, stored, written)

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
            sql`
              UPDATE to_do SET completed_at = ${completedAt}
              WHERE id = ${id} AND completed_at IS NULL
              RETURNING id, title
            `,
            (toDo) => ToDoDone.make({ toDo }),
          )
        }),
        remove: Effect.fn("ToDos.remove")((id) =>
          change(
            Effect.gen(function* () {
              const ids = yield* decodeIds(
                yield* sql`SELECT id FROM to_do_image WHERE to_do_id = ${id}`,
              )

              yield* sql`DELETE FROM to_do_image WHERE to_do_id = ${id}`
              yield* sql`DELETE FROM to_do WHERE id = ${id}`
              yield* Effect.forEach(ids, ({ id: imageId }) => removeFiles(imageId), {
                discard: true,
              })
            }),
          ),
        ),
        attach: Effect.fn("ToDos.attach")(function* (id, images) {
          const stored = yield* decodeUploads(images)

          if (stored.length === 0) return yield* list

          return yield* change(
            withImages((written) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  const found = yield* sql`SELECT id FROM to_do WHERE id = ${id}`

                  if (found.length === 0) return yield* Effect.fail(saveFailed())

                  return yield* storeImages(id, stored, written)
                }),
              ),
            ),
          )
        }),
        removeImage: Effect.fn("ToDos.removeImage")((id) =>
          change(
            Effect.gen(function* () {
              yield* sql`DELETE FROM to_do_image WHERE id = ${id}`
              yield* removeFiles(id)
            }),
          ),
        ),
        readImage: Effect.fn("ToDos.readImage")(function* (id, size) {
          const rows = yield* sql<{ media_type: string; thumbnail_type: string }>`
            SELECT media_type, thumbnail_type FROM to_do_image WHERE id = ${id}
          `.pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't open a to-do image", cause)),
            Effect.mapError(openFailed),
          )

          const row = rows[0]

          if (row === undefined) return yield* Effect.fail(openFailed())

          const path = size === "full" ? imageFile(id) : thumbnailFile(id)

          const bytes = yield* fs.readFile(path).pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't open a to-do image", cause)),
            Effect.mapError(openFailed),
          )

          const mediaType = yield* decodeMediaType(
            size === "full" ? row.media_type : row.thumbnail_type,
          ).pipe(Effect.mapError(openFailed))

          return { mediaType, data: Base64.encode(bytes) }
        }),
      })
    }),
  )
}
