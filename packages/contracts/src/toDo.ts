import { Effect, Schema } from "effect"
import { ImageMediaType } from "./thread"

export const ToDoTitle = Schema.Trimmed.check(Schema.isNonEmpty())

export const ToDoImageSize = Schema.Literals(["thumbnail", "full"])

export type ToDoImageSize = typeof ToDoImageSize.Type

export class ToDoImage extends Schema.Class<ToDoImage>("ToDoImage")({
  id: Schema.Int,
  mediaType: ImageMediaType,
}) {}

export const ToDoImageUpload = Schema.Struct({
  mediaType: ImageMediaType,
  data: Schema.String.check(Schema.isNonEmpty()),
  thumbnail: Schema.String.check(Schema.isNonEmpty()),
  thumbnailMediaType: ImageMediaType,
})

export type ToDoImageUpload = typeof ToDoImageUpload.Type

export const ToDoImageUploads = Schema.Array(ToDoImageUpload).pipe(
  Schema.optionalKey,
  Schema.withConstructorDefault(Effect.succeed([])),
)

export class ToDo extends Schema.Class<ToDo>("ToDo")({
  id: Schema.Int,
  title: ToDoTitle,
  notes: Schema.String,
  done: Schema.Boolean,
  images: Schema.Array(ToDoImage).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
}) {}

export class ToDoError extends Schema.TaggedError<ToDoError>()("ToDoError", {
  message: Schema.String,
}) {}
