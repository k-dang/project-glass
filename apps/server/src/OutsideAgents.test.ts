import { it } from "@effect/vitest"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { migrationLoader } from "./Migrations"
import { OutsideAgents } from "./OutsideAgents"

const pausingAfterAuthenticateRead = (afterRead: Effect.Effect<void>) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.map(
      SqlClient.SqlClient,
      (sql) =>
        new Proxy(sql, {
          apply: (target, _self, args: [TemplateStringsArray, ...Array<unknown>]) => {
            const statement = target(...args)

            return args[0].join("?").includes("WHERE token_digest")
              ? Effect.tap(statement, () => afterRead)
              : statement
          },
        }),
    ),
  ).pipe(
    Layer.provideMerge(SqliteMigrator.layer({ loader: migrationLoader })),
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  )

it.effect("ends a credential whose agent is revoked while it authenticates", () =>
  Effect.gen(function* () {
    const read = yield* Deferred.make<void>()
    const resume = yield* Deferred.make<void>()

    yield* Effect.gen(function* () {
      const outsideAgents = yield* OutsideAgents
      const bearer = yield* outsideAgents.issue("Codex")

      const [agent] = yield* outsideAgents
        .watch()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      const authenticating = yield* Effect.forkChild(outsideAgents.authenticate(bearer))

      yield* Deferred.await(read)
      yield* outsideAgents.revoke(agent!.id)
      yield* outsideAgents.issue("Claude Code")
      yield* Deferred.succeed(resume, undefined)

      const credential = Option.getOrThrow(yield* Fiber.join(authenticating))

      yield* credential.revoked
    }).pipe(
      Effect.provide(
        OutsideAgents.layer.pipe(
          Layer.provide(
            pausingAfterAuthenticateRead(
              Deferred.succeed(read, undefined).pipe(Effect.andThen(Deferred.await(resume))),
            ),
          ),
        ),
      ),
    )
  }),
)
