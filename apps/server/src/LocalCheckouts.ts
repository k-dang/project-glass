import {
  AgentError,
  Branches,
  FollowedRepository,
  InvalidLocalCheckout,
  LocalCheckout,
  repositoryKey,
} from "@glass/contracts"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Git } from "./git"

const LinkedCheckout = Schema.Struct({ path: Schema.String, remote: Schema.String })

const decodeLinked = Schema.decodeUnknownEffect(Schema.Array(LinkedCheckout))

const decodeCheckouts = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      owner: FollowedRepository.fields.owner,
      repo: FollowedRepository.fields.repo,
      path: Schema.String,
    }),
  ),
)

const parseGitHubRemote = (url: string) => {
  const [, owner, repo] = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim()) ?? []

  return owner === undefined || repo === undefined
    ? null
    : { owner: owner.toLowerCase(), repo: repo.toLowerCase() }
}

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save your Local checkouts. Try again." })

export class LocalCheckouts extends Context.Service<
  LocalCheckouts,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<LocalCheckout>, AgentError>
    readonly link: (path: string) => Effect.Effect<LocalCheckout, InvalidLocalCheckout | AgentError>
    readonly get: (
      repository: FollowedRepository,
    ) => Effect.Effect<typeof LinkedCheckout.Type, InvalidLocalCheckout | AgentError>
    readonly branches: (
      repository: FollowedRepository,
    ) => Effect.Effect<Branches, InvalidLocalCheckout | AgentError>
  }
>()("@glass/server/LocalCheckouts") {
  static readonly layer = Layer.effect(
    LocalCheckouts,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const git = yield* Git

      const get = Effect.fn("LocalCheckouts.get")(function* (repository: FollowedRepository) {
        const [found] = yield* sql`
          SELECT path, remote FROM local_checkout
          WHERE owner = ${repository.owner} AND repo = ${repository.repo}
        `.pipe(
          Effect.flatMap(decodeLinked),
          Effect.tapError((cause) => Effect.logWarning("Couldn't read a Local checkout", cause)),
          Effect.mapError(storageFailure),
        )

        if (found === undefined)
          return yield* new InvalidLocalCheckout({
            message: `Link a Local checkout of ${repositoryKey(repository)} first.`,
          })

        return found
      })

      const link = Effect.fn("LocalCheckouts.link")(function* (path: string) {
        const notAClone = new InvalidLocalCheckout({
          message:
            "That folder isn't a clone of a GitHub repository. Choose the folder you cloned it into.",
        })

        const top = yield* git
          .run(path, ["rev-parse", "--show-toplevel"])
          .pipe(Effect.mapError(() => notAClone))

        const remotes = yield* git
          .run(top, ["config", "--get-regexp", "^remote\\..*\\.url$"])
          .pipe(Effect.orElseSucceed(() => ""))

        const onGitHub = remotes.split("\n").flatMap((line) => {
          const [, remote, url = ""] = /^remote\.(.+)\.url\s+(.+)$/.exec(line) ?? []
          const repository = parseGitHubRemote(url)

          return remote === undefined || repository === null ? [] : [{ remote, ...repository }]
        })

        const found = onGitHub.find(({ remote }) => remote === "origin") ?? onGitHub[0]

        if (found === undefined) return yield* notAClone

        const { remote, owner, repo } = found

        yield* sql`
          INSERT INTO local_checkout ${sql.insert({ owner, repo, path: top, remote })}
          ON CONFLICT (owner, repo) DO UPDATE SET path = excluded.path, remote = excluded.remote
        `.pipe(
          Effect.tapError((cause) => Effect.logWarning("Couldn't save a Local checkout", cause)),
          Effect.mapError(storageFailure),
        )

        return new LocalCheckout({ repository: new FollowedRepository({ owner, repo }), path: top })
      })

      const branches = Effect.fn("LocalCheckouts.branches")(function* (
        repository: FollowedRepository,
      ) {
        const { path, remote } = yield* get(repository)

        const listed = yield* git
          .run(path, ["for-each-ref", "--format=%(refname:strip=3)", `refs/remotes/${remote}`])
          .pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't list branches", cause)),
            Effect.mapError(
              () =>
                new AgentError({ message: `Couldn't list the branches in ${path}. Try again.` }),
            ),
          )

        const names = listed.split("\n").filter((branch) => branch !== "" && branch !== "HEAD")

        const remoteHead = yield* git
          .run(path, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`])
          .pipe(
            Effect.map((ref) => ref.slice(remote.length + 1)),
            Effect.option,
          )

        const defaultBranch = Option.getOrElse(
          Option.filter(remoteHead, (branch) => names.includes(branch)),
          () => ["main", "master"].find((branch) => names.includes(branch)) ?? names[0] ?? null,
        )

        return new Branches({ defaultBranch, branches: names })
      })

      return LocalCheckouts.of({
        list: Effect.fn("LocalCheckouts.list")(function* () {
          const rows = yield* sql`
            SELECT owner, repo, path FROM local_checkout ORDER BY owner, repo
          `.pipe(
            Effect.flatMap(decodeCheckouts),
            Effect.tapError((cause) =>
              Effect.logWarning("Couldn't read the Local checkouts", cause),
            ),
            Effect.mapError(storageFailure),
          )

          return rows.map(
            ({ owner, repo, path }) =>
              new LocalCheckout({ repository: new FollowedRepository({ owner, repo }), path }),
          )
        }),
        link,
        get,
        branches,
      })
    }),
  )
}
