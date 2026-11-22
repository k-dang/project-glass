import { THREAD_FILES_PATH, type ThreadFile } from "@glass/contracts"
import { Effect, Match } from "effect"
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http"
import { extname } from "node:path"
import { Threads } from "./Threads"

const textTypes = new Map([
  [".css", "text/css"],
  [".csv", "text/csv"],
  [".htm", "text/html"],
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".mjs", "text/javascript"],
  [".xml", "application/xml"],
])

const typed = (status: number, contentType: string) => ({
  status,
  headers: { "content-type": contentType, "x-content-type-options": "nosniff" },
})

const respond = (status: number, contentType: string, text: string) =>
  HttpServerResponse.text(text, typed(status, contentType))

const refuse = (status: number, message: string) =>
  respond(status, "text/plain; charset=utf-8", message)

const served = (path: string, file: ThreadFile) =>
  Match.valueTags(file, {
    TextFile: ({ text }) =>
      respond(
        200,
        `${textTypes.get(extname(path).toLowerCase()) ?? "text/plain"}; charset=utf-8`,
        text,
      ),
    ImageFile: ({ mediaType, data }) =>
      HttpServerResponse.uint8Array(Buffer.from(data, "base64"), typed(200, mediaType)),
    BinaryFile: () => refuse(415, "Glass serves only text and image files from a Thread's folder."),
    FileTooLarge: () => refuse(413, "This file is too large for Glass to serve."),
  })

const fileOf = (request: HttpServerRequest.HttpServerRequest) => {
  const { pathname } = new URL(request.url, "http://127.0.0.1")
  const [threadId = "", ...segments] = pathname.slice(THREAD_FILES_PATH.length + 1).split("/")

  try {
    return { threadId, path: segments.map(decodeURIComponent).join("/") }
  } catch {
    return null
  }
}

export const ThreadFileRoutes = HttpRouter.add("GET", `${THREAD_FILES_PATH}/*`, (request) =>
  Effect.gen(function* () {
    const file = fileOf(request)

    if (file === null || file.threadId === "" || file.path === "")
      return refuse(404, "No such file.")

    const threads = yield* Threads

    return yield* threads.file(file.threadId, file.path).pipe(
      Effect.map((found) => served(file.path, found)),
      Effect.catchTags({
        ThreadNotFound: () => Effect.succeed(refuse(404, "This Thread is gone.")),
        ThreadError: ({ message }) => Effect.succeed(refuse(404, message)),
      }),
    )
  }),
)
