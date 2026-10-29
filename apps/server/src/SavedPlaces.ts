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
    readonly get: () => Effect.Effect<SavedPlace | null, SavedPlaceError>
    readonly save: (destination: ResumableDestination) => Effect.Effect<SavedPlace, SavedPlaceError>
  }
>()("@glass/server/SavedPlaces") {
  static readonly layer = Layer.effect(
    SavedPlaces,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      return SavedPlaces.of({
        get: Effect.fn("SavedPlaces.get")(
          function* () {
            const [row] = yield* sql`
              SELECT destination, saved_at AS savedAt FROM saved_place WHERE id = 1
            `

            return row === undefined ? null : new SavedPlace(yield* decodeStored(row))
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
              INSERT INTO saved_place (id, destination, saved_at)
              VALUES (1, ${encoded}, ${DateTime.formatIso(savedAt)})
              ON CONFLICT(id) DO UPDATE SET
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
