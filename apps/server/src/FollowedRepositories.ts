import {
  FollowedRepository,
  InvalidRepositoryInput,
  repositoryKey,
  SettingsError,
} from "@glass/contracts"
import { Context, Effect, Layer, Schema, SchemaGetter } from "effect"
import { SettingsStore } from "./SettingsStore"

const repositoryInput = Schema.Trim.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isPattern(/^(?:https?:\/\/(?:www\.)?github\.com\/)?[^/]+\/[^/]+\/?$/i),
    ),
  ),
  Schema.decodeTo(FollowedRepository, {
    decode: SchemaGetter.transform((input) => {
      const name = input.replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
      const [owner, repo] = name.replace(/\/$/, "").split("/")

      return {
        owner: owner!.toLowerCase(),
        repo: (name === input ? repo! : repo!.replace(/\.git$/i, "")).toLowerCase(),
      }
    }),
    encode: SchemaGetter.transform(({ owner, repo }) => `${owner}/${repo}`),
  }),
)

const decodeRepository = Schema.decodeUnknownEffect(repositoryInput)

export class FollowedRepositories extends Context.Service<
  FollowedRepositories,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<FollowedRepository>, SettingsError>
    readonly follow: (
      input: string,
    ) => Effect.Effect<ReadonlyArray<FollowedRepository>, InvalidRepositoryInput | SettingsError>
    readonly unfollow: (
      repository: FollowedRepository,
    ) => Effect.Effect<ReadonlyArray<FollowedRepository>, SettingsError>
  }
>()("@glass/server/FollowedRepositories") {
  static readonly layer = Layer.effect(
    FollowedRepositories,
    Effect.gen(function* () {
      const settings = yield* SettingsStore

      const update = (
        change: (
          repositories: ReadonlyArray<FollowedRepository>,
        ) => ReadonlyArray<FollowedRepository>,
      ) =>
        settings
          .update((current) => ({
            ...current,
            followedRepositories: change(current.followedRepositories),
          }))
          .pipe(Effect.map((updated) => updated.followedRepositories))

      return FollowedRepositories.of({
        list: Effect.fn("FollowedRepositories.list")(function* () {
          return (yield* settings.read()).followedRepositories
        }),
        follow: Effect.fn("FollowedRepositories.follow")(function* (input) {
          const repository = yield* decodeRepository(input).pipe(
            Effect.mapError(() => new InvalidRepositoryInput({ input })),
          )

          return yield* update((repositories) =>
            repositories.some((entry) => repositoryKey(entry) === repositoryKey(repository))
              ? repositories
              : [...repositories, repository].toSorted((a, b) =>
                  repositoryKey(a).localeCompare(repositoryKey(b)),
                ),
          )
        }),
        unfollow: Effect.fn("FollowedRepositories.unfollow")((repository) =>
          update((repositories) =>
            repositories.filter((entry) => repositoryKey(entry) !== repositoryKey(repository)),
          ),
        ),
      })
    }),
  )
}
