import { ThreadError } from "@glass/contracts"
import { Context, Data, Effect, Layer, Match, Option, Predicate, Result, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { randomUUID } from "node:crypto"
import { Threads } from "./Threads"
import {
  isHtmlDocument,
  localImagesIn,
  MAX_PAGE_BYTES,
  unescapedFilePath,
  viewportHeightUnitIn,
  withBootstrap,
  withImages,
} from "./visualizationPage"

export class VisualizationRefused extends Schema.TaggedError<VisualizationRefused>()(
  "VisualizationRefused",
  { message: Schema.String },
) {}

export type VisualizationSource = Data.TaggedEnum<{
  Html: { readonly html: string }
  File: { readonly path: string }
}>

export const VisualizationSource = Data.taggedEnum<VisualizationSource>()

export type ShownBy = Data.TaggedEnum<{
  Thread: { readonly threadId: string }
  GlobalChat: { readonly sessionId: string }
}>

export const ShownBy = Data.taggedEnum<ShownBy>()

const MIB = 1024 * 1024

const transcriptOf = (by: ShownBy) =>
  Match.valueTags(by, {
    Thread: ({ threadId }) => threadId,
    GlobalChat: ({ sessionId }) => sessionId,
  })

const refuse = (message: string) => Effect.fail(new VisualizationRefused({ message }))

const storageFailure = (cause: SqlError.SqlError) =>
  Effect.logWarning("Couldn't read or save a Visualization", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new ThreadError({ message: "Couldn't read or save the Visualization. Try again." }),
      ),
    ),
  )

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ html: Schema.String })))

export class Visualizations extends Context.Service<
  Visualizations,
  {
    readonly show: (
      by: ShownBy,
      source: VisualizationSource,
    ) => Effect.Effect<string, VisualizationRefused | ThreadError>
    readonly page: (id: string) => Effect.Effect<Option.Option<string>, ThreadError>
  }
>()("@glass/server/Visualizations") {
  static readonly layer = Layer.effect(
    Visualizations,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const threads = yield* Threads

      const pageFile = Effect.fn("Visualizations.pageFile")(function* (
        threadId: string,
        path: string,
      ) {
        const file = yield* threads
          .file(threadId, path)
          .pipe(Effect.catch(() => refuse(`Glass couldn't read ${path} in your Thread's folder.`)))

        return yield* Match.valueTags(file, {
          TextFile: ({ text }) => Effect.succeed(text),
          FileTooLarge: () => refuse(`${path} is too large to show.`),
          ImageFile: () => refuse(`${path} isn't an HTML file.`),
          BinaryFile: () => refuse(`${path} isn't an HTML file.`),
        })
      })

      const imageData = (threadId: string, reference: string) => {
        const path = unescapedFilePath(reference)

        return threads.file(threadId, path).pipe(
          Effect.mapError(() => path),
          Effect.flatMap((file) =>
            Predicate.isTagged(file, "ImageFile")
              ? Effect.succeed([reference, `data:${file.mediaType};base64,${file.data}`] as const)
              : Effect.fail(path),
          ),
        )
      }

      const inlineImages = Effect.fn("Visualizations.inlineImages")(function* (
        html: string,
        by: ShownBy,
      ) {
        const references = localImagesIn(html)

        if (references.length === 0) return html

        const threadId = yield* Match.valueTags(by, {
          Thread: (thread) => Effect.succeed(thread.threadId),
          GlobalChat: () =>
            refuse(
              "Only a Thread's agent can show local images, from its folder. Use https images instead.",
            ),
        })

        const uses = new Map<string, number>()

        for (const { path } of references) uses.set(path, (uses.get(path) ?? 0) + 1)

        let bytes = Buffer.byteLength(html)

        const read = yield* Effect.forEach(
          uses,
          ([reference, count]) =>
            imageData(threadId, reference).pipe(
              Effect.result,
              Effect.tap((image) => {
                if (Result.isFailure(image)) return Effect.void

                bytes += (image.success[1].length - Buffer.byteLength(reference)) * count

                return bytes > MAX_PAGE_BYTES
                  ? refuse(
                      `With its images inlined the page is over ${MAX_PAGE_BYTES / MIB} MiB. Use smaller or fewer images.`,
                    )
                  : Effect.void
              }),
            ),
          { concurrency: 4 },
        )

        const missing = read.flatMap((image) => (Result.isFailure(image) ? [image.failure] : []))

        if (missing.length > 0)
          return yield* refuse(
            `Glass couldn't read these images in your Thread's folder: ${missing.join(", ")}. Use absolute paths to image files inside the folder, or remove them.`,
          )

        return withImages(
          html,
          references,
          new Map(read.flatMap((image) => (Result.isSuccess(image) ? [image.success] : []))),
        )
      })

      const prepared = Effect.fn("Visualizations.prepared")(function* (
        by: ShownBy,
        source: VisualizationSource,
      ) {
        const html = yield* Match.valueTags(source, {
          Html: (page) => Effect.succeed(page.html),
          File: ({ path }) =>
            Match.valueTags(by, {
              Thread: ({ threadId }) => pageFile(threadId, path),
              GlobalChat: () =>
                refuse(
                  "Only a Thread's agent can show a file, from its folder. Pass html instead.",
                ),
            }),
        })

        if (!isHtmlDocument(html))
          return yield* refuse("The page must start with <!doctype html> or <html>.")

        const unit = viewportHeightUnitIn(html)

        if (unit !== null)
          return yield* refuse(
            `The page uses a viewport height unit (${unit}). Its frame grows to fit the page, so a height that follows the frame grows forever. Let content set the height, or use pixel heights.`,
          )

        return yield* inlineImages(withBootstrap(html), by)
      })

      return Visualizations.of({
        show: Effect.fn("Visualizations.show")(function* (by, source) {
          const html = yield* prepared(by, source)
          const id = randomUUID()

          yield* sql`
            INSERT INTO visualization ${sql.insert({ id, thread_id: transcriptOf(by), html })}
          `.pipe(Effect.catchTag("SqlError", storageFailure))

          return id
        }),
        page: Effect.fn("Visualizations.page")(function* (id) {
          const rows = yield* sql`SELECT html FROM visualization WHERE id = ${id}`.pipe(
            Effect.flatMap(decodeRows),
            Effect.catchTags({ SqlError: storageFailure, SchemaError: Effect.die }),
          )

          return Option.map(Option.fromNullishOr(rows[0]), ({ html }) => html)
        }),
      })
    }),
  )
}
