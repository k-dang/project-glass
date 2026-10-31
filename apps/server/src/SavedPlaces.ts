import { ResumableDestination, SavedPlace, SavedPlaceError } from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"

const encodeDestination = Schema.encodeEffect(Schema.fromJsonString(ResumableDestination))

const decodeStored = Schema.decodeUnknownEffect(
  Schema.Struct({
    destination: Schema.fromJsonString(ResumableDestination),
    savedAt: Schema.DateTimeUtcFromString,
  }),
)

export class SavedPlaces extends Context.Service<
  SavedPlaces,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<SavedPlace>, SavedPlaceError>
    readonly save: (destination: ResumableDestination) => Effect.Effect<SavedPlace, SavedPlaceError>
  }
>()("@glass/server/SavedPlaces") {
  static readonly layer = Layer.effect(
    SavedPlaces,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return SavedPlaces.of({
        list: Effect.fn("SavedPlaces.list")(
          function* () {
            const rows = yield* sql`
              SELECT destination, saved_at AS savedAt FROM saved_place ORDER BY saved_at DESC
            `

            return yield* Effect.forEach(rows, (row) =>
              decodeStored(row).pipe(Effect.map((stored) => new SavedPlace(stored))),
            )
          },
          Effect.mapError(
            () => new SavedPlaceError({ message: "Couldn't read your saved place. Try again." }),
          ),
        ),
        save: Effect.fn("SavedPlaces.save")(
          function* (destination: ResumableDestination) {
            const savedAt = yield* DateTime.now
            const encoded = yield* encodeDestination(destination)

            yield* sql`
              INSERT INTO saved_place (area, destination, saved_at)
              VALUES (${destination.area}, ${encoded}, ${DateTime.formatIso(savedAt)})
              ON CONFLICT(area) DO UPDATE SET
                destination = excluded.destination, saved_at = excluded.saved_at
            `

            return new SavedPlace({ destination, savedAt })
          },
          Effect.mapError(
            () => new SavedPlaceError({ message: "Couldn't save your place. Try again." }),
          ),
        ),
      })
    }),
  )
}
