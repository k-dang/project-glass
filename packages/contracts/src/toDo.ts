import { Schema } from "effect"

export const ToDoTitle = Schema.Trimmed.check(Schema.isNonEmpty())

export class ToDo extends Schema.Class<ToDo>("ToDo")({
  id: Schema.Int,
  title: ToDoTitle,
  notes: Schema.String,
  done: Schema.Boolean,
}) {}

export class ToDoError extends Schema.TaggedError<ToDoError>()("ToDoError", {
  message: Schema.String,
}) {}
