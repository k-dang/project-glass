import {
  type ConnectionError,
  InvalidSkillPackName,
  InvalidSkillPackUrl,
  isSkillPackName,
  shortCommit,
  Skill,
  SkillPack,
  SkillPackError,
  SkillPackNameTaken,
  SkillPackNotFound,
  SkillPackNotReadable,
  SkillPackPreview,
  SkillPackSource,
  SkillPackUpdate,
  SkippedSkill,
} from "@glass/contracts"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { GitHubClient, type TreeBlob } from "./github/GitHubClient"
import {
  fallbackSkillName,
  filesOf,
  readSkill,
  skillDirectories,
  skillFilePath,
  skillPackSources,
  suggestedName,
} from "./skillPackContents"

interface PackSkill {
  readonly directory: string
  readonly skill: Skill
  readonly files: ReadonlyArray<TreeBlob>
}

interface PackContents {
  readonly skills: ReadonlyArray<PackSkill>
  readonly skipped: ReadonlyArray<SkippedSkill>
}

const decodePacks = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ref: Schema.NullOr(Schema.String),
      pin_id: Schema.Int,
      owner: Schema.String,
      repo: Schema.String,
      path: Schema.String,
      commit_sha: Schema.String,
    }),
  ),
)

const decodeSkills = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      pin_id: Schema.Int,
      directory: Schema.String,
      name: Schema.String,
      description: Schema.String,
    }),
  ),
)

const decodeFiles = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      path: Schema.String,
      blob_sha: Schema.String,
      executable: Schema.BooleanFromBit,
    }),
  ),
)

const decodeId = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.Int })))

const repositoryLabel = ({ owner, repo }: SkillPackSource) => `${owner}/${repo}`

const atCommit = (source: SkillPackSource, commit: string) =>
  `${repositoryLabel(source)} at ${shortCommit(commit)}`

const folderLabel = (source: SkillPackSource, commit: string) =>
  source.path === "" ? atCommit(source, commit) : `${source.path} in ${atCommit(source, commit)}`

const repositoryMissing = (source: SkillPackSource) =>
  new SkillPackNotReadable({
    message: `GitHub couldn't find ${repositoryLabel(source)}, or your GitHub connection can't see it.`,
  })

const nothingToAdd = (source: SkillPackSource, commit: string) =>
  new SkillPackNotReadable({
    message: `None of the skills in ${folderLabel(source, commit)} can load.`,
  })

const isCommitRef = (ref: string, commit: string) =>
  /^[0-9a-f]{7,40}$/.test(ref) && commit.startsWith(ref)

const fileKey = ({ path, sha, executable }: TreeBlob) => `${path}\0${sha}\0${executable}`

const sameFiles = (a: ReadonlyArray<TreeBlob>, b: ReadonlyArray<TreeBlob>) =>
  a.length === b.length &&
  a.map(fileKey).toSorted().join("\n") === b.map(fileKey).toSorted().join("\n")

const sameSkill = (a: PackSkill, b: PackSkill) =>
  a.skill.name === b.skill.name &&
  a.skill.description === b.skill.description &&
  sameFiles(a.files, b.files)

const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name)

const storageFailure = (cause: unknown) =>
  Effect.logWarning("Couldn't access the Skill packs", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new SkillPackError({ message: "Glass couldn't access your Skill packs. Try again." }),
      ),
    ),
  )

type SkillPackList = Effect.Effect<ReadonlyArray<SkillPack>, SkillPackError>

type ReadError = SkillPackNotReadable | SkillPackError | ConnectionError

type Reading<A, E = never> = Effect.Effect<A, ReadError | E>

export class SkillPacks extends Context.Service<
  SkillPacks,
  {
    readonly list: () => SkillPackList
    readonly preview: (url: string) => Reading<SkillPackPreview, InvalidSkillPackUrl>
    readonly add: (
      source: SkillPackSource,
      commit: string,
      name: string,
    ) => Reading<ReadonlyArray<SkillPack>, InvalidSkillPackName | SkillPackNameTaken>
    readonly previewUpdate: (name: string) => Reading<SkillPackUpdate, SkillPackNotFound>
    readonly update: (
      name: string,
      commit: string,
    ) => Reading<ReadonlyArray<SkillPack>, SkillPackNotFound>
    readonly remove: (name: string) => SkillPackList
  }
>()("@glass/server/SkillPacks") {
  static readonly layer = Layer.effect(
    SkillPacks,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const github = yield* GitHubClient

      const resolve = Effect.fnUntraced(function* (candidates: ReadonlyArray<SkillPackSource>) {
        for (const source of candidates) {
          const commit = yield* github
            .commitOf(source, source.ref)
            .pipe(
              Effect.catchTag("RepositoryMissing", () => Effect.fail(repositoryMissing(source))),
            )

          if (commit !== null) return { source, commit }
        }

        const [first] = candidates

        return yield* new SkillPackNotReadable({
          message:
            first!.ref === null
              ? `${repositoryLabel(first!)} has no default branch.`
              : `GitHub has no branch, tag, or commit in ${repositoryLabel(first!)} that this URL names.`,
        })
      })

      const read = Effect.fnUntraced(function* (source: SkillPackSource, commit: string) {
        const tree = yield* github
          .folderTree(source, commit, source.path)
          .pipe(Effect.catchTag("RepositoryMissing", () => Effect.fail(repositoryMissing(source))))

        if (tree === null) {
          return yield* new SkillPackNotReadable({
            message: `${atCommit(source, commit)} has no folder ${source.path}.`,
          })
        }

        const { blobs, truncated } = yield* github.treeBlobs(source, tree)

        if (truncated) {
          return yield* new SkillPackNotReadable({
            message: `GitHub can't list every file in ${folderLabel(source, commit)}.`,
          })
        }

        const directories = skillDirectories(blobs)

        if (directories.length === 0) {
          return yield* new SkillPackNotReadable({
            message: `No folder in ${folderLabel(source, commit)} has a SKILL.md.`,
          })
        }

        const loaded = yield* Effect.forEach(
          directories,
          (directory) => {
            const files = filesOf(directory, blobs)
            const skillFile = files.find(({ path }) => path === skillFilePath(directory))!

            return github.blob(source, skillFile.sha).pipe(
              Effect.map((bytes) => ({
                directory,
                files,
                result: readSkill(
                  directory,
                  new TextDecoder().decode(bytes),
                  fallbackSkillName(source, directory),
                ),
              })),
            )
          },
          { concurrency: 8 },
        )

        return {
          skills: loaded.flatMap(({ directory, files, result }) =>
            result instanceof Skill ? [{ directory, files, skill: result }] : [],
          ),
          skipped: loaded.flatMap(({ result }) => (result instanceof SkippedSkill ? [result] : [])),
        } satisfies PackContents
      })

      const packRows = Effect.gen(function* () {
        const packs = yield* decodePacks(
          yield* sql`
            SELECT pack.name, pack.ref, pack.pin_id, pin.owner, pin.repo, pin.path, pin.commit_sha
            FROM skill_pack AS pack JOIN skill_pack_pin AS pin ON pin.id = pack.pin_id
            ORDER BY pack.name
          `,
        )

        const skills = yield* decodeSkills(
          yield* sql`
            SELECT pin_id, directory, name, description FROM skill_pack_skill
            WHERE pin_id IN (SELECT pin_id FROM skill_pack)
            ORDER BY name
          `,
        )

        return packs.map((pack) => ({
          pinId: pack.pin_id,
          pack: new SkillPack({
            name: pack.name,
            source: new SkillPackSource({
              owner: pack.owner,
              repo: pack.repo,
              ref: pack.ref,
              path: pack.path,
            }),
            commit: pack.commit_sha,
            updatable: pack.ref === null || !isCommitRef(pack.ref, pack.commit_sha),
            skills: skills.flatMap((skill) =>
              skill.pin_id === pack.pin_id
                ? [new Skill({ name: skill.name, description: skill.description })]
                : [],
            ),
          }),
        }))
      }).pipe(Effect.catch(storageFailure))

      const list = packRows.pipe(Effect.map((rows) => rows.map(({ pack }) => pack)))

      const existingPin = (source: SkillPackSource, commit: string) =>
        sql`
          SELECT id FROM skill_pack_pin
          WHERE owner = ${source.owner} AND repo = ${source.repo}
            AND path = ${source.path} AND commit_sha = ${commit}
        `.pipe(
          Effect.flatMap(decodeId),
          Effect.map((rows) => rows[0]?.id),
        )

      const preparePin = Effect.fnUntraced(function* (source: SkillPackSource, commit: string) {
        const existing = yield* existingPin(source, commit).pipe(Effect.catch(storageFailure))

        if (existing !== undefined) return Effect.succeed(existing)

        const { skills } = yield* read(source, commit)

        if (skills.length === 0) return yield* nothingToAdd(source, commit)

        const downloaded = yield* Effect.forEach(
          skills.flatMap(({ files }) => files),
          (file) =>
            github.blob(source, file.sha).pipe(Effect.map((contents) => ({ ...file, contents }))),
          { concurrency: 8 },
        )

        return Effect.gen(function* () {
          const storedMeanwhile = yield* existingPin(source, commit)

          if (storedMeanwhile !== undefined) return storedMeanwhile

          const [created] = yield* decodeId(
            yield* sql`
              INSERT INTO skill_pack_pin ${sql.insert({
                owner: source.owner,
                repo: source.repo,
                path: source.path,
                commit_sha: commit,
              })}
              RETURNING id
            `,
          )

          const pinId = created!.id

          yield* sql`
            INSERT INTO skill_pack_skill ${sql.insert(
              skills.map(({ directory, skill }) => ({
                pin_id: pinId,
                directory,
                name: skill.name,
                description: skill.description,
              })),
            )}
          `

          yield* sql`
            INSERT INTO skill_pack_file ${sql.insert(
              downloaded.map(({ path, sha, executable, contents }) => ({
                pin_id: pinId,
                path,
                blob_sha: sha,
                executable: executable ? 1 : 0,
                contents,
              })),
            )}
          `

          return pinId
        })
      })

      const releaseUnusedPins = Effect.gen(function* () {
        yield* sql`DELETE FROM skill_pack_skill WHERE pin_id NOT IN (SELECT pin_id FROM skill_pack)`
        yield* sql`DELETE FROM skill_pack_file WHERE pin_id NOT IN (SELECT pin_id FROM skill_pack)`
        yield* sql`DELETE FROM skill_pack_pin WHERE id NOT IN (SELECT pin_id FROM skill_pack)`
      })

      const packNamed = (name: string) =>
        packRows.pipe(
          Effect.flatMap((rows) => {
            const row = rows.find(({ pack }) => pack.name === name)

            return row === undefined
              ? Effect.fail(new SkillPackNotFound({ name }))
              : Effect.succeed(row)
          }),
        )

      const storedContents = (pinId: number) =>
        Effect.gen(function* () {
          const skills = yield* decodeSkills(
            yield* sql`SELECT pin_id, directory, name, description FROM skill_pack_skill WHERE pin_id = ${pinId}`,
          )

          const files = (yield* decodeFiles(
            yield* sql`SELECT path, blob_sha, executable FROM skill_pack_file WHERE pin_id = ${pinId}`,
          )).map(({ path, blob_sha, executable }) => ({ path, sha: blob_sha, executable }))

          return skills.map(({ directory, name, description }) => ({
            directory,
            skill: new Skill({ name, description }),
            files: filesOf(directory, files),
          }))
        }).pipe(Effect.catch(storageFailure))

      return SkillPacks.of({
        list: Effect.fn("SkillPacks.list")(() => list),

        preview: Effect.fn("SkillPacks.preview")(function* (url) {
          const candidates = skillPackSources(url)

          if (candidates === null) return yield* new InvalidSkillPackUrl({ input: url })

          const { source, commit } = yield* resolve(candidates)
          const { skills, skipped } = yield* read(source, commit)

          return new SkillPackPreview({
            source,
            commit,
            suggestedName: suggestedName(source),
            skills: skills.map(({ skill }) => skill).toSorted(byName),
            skipped,
          })
        }),

        add: Effect.fn("SkillPacks.add")(function* (source, commit, name) {
          if (!isSkillPackName(name)) return yield* new InvalidSkillPackName({ name })

          const taken = () =>
            sql`SELECT 1 FROM skill_pack WHERE name = ${name}`.pipe(
              Effect.map((rows) => rows.length > 0),
            )

          if (yield* taken().pipe(Effect.catch(storageFailure))) {
            return yield* new SkillPackNameTaken({ name })
          }

          const storePin = yield* preparePin(source, commit)

          yield* Effect.gen(function* () {
            if (yield* taken()) return yield* new SkillPackNameTaken({ name })

            const pinId = yield* storePin

            return yield* sql`
              INSERT INTO skill_pack ${sql.insert({ name, ref: source.ref, pin_id: pinId })}
            `
          }).pipe(
            sql.withTransaction,
            Effect.catchIf((error) => !(error instanceof SkillPackNameTaken), storageFailure),
          )

          return yield* list
        }),

        previewUpdate: Effect.fn("SkillPacks.previewUpdate")(function* (name) {
          const { pack, pinId } = yield* packNamed(name)
          const { commit } = yield* resolve([pack.source])
          const next = yield* read(pack.source, commit)
          const current = yield* storedContents(pinId)
          const pinned = new Map(current.map((entry) => [entry.directory, entry]))
          const resolved = new Set(next.skills.map(({ directory }) => directory))

          return new SkillPackUpdate({
            name,
            from: pack.commit,
            to: commit,
            added: next.skills
              .flatMap(({ directory, skill }) => (pinned.has(directory) ? [] : [skill]))
              .toSorted(byName),
            removed: current
              .flatMap(({ directory, skill }) => (resolved.has(directory) ? [] : [skill]))
              .toSorted(byName),
            changed: next.skills
              .flatMap(({ directory, skill, files }) => {
                const before = pinned.get(directory)

                return before !== undefined && !sameSkill(before, { directory, skill, files })
                  ? [skill]
                  : []
              })
              .toSorted(byName),
            skipped: next.skipped,
          })
        }),

        update: Effect.fn("SkillPacks.update")(function* (name, commit) {
          const { pack } = yield* packNamed(name)
          const storePin = yield* preparePin(pack.source, commit)

          yield* Effect.gen(function* () {
            const pinId = yield* storePin

            yield* sql`UPDATE skill_pack SET pin_id = ${pinId} WHERE name = ${name}`
            yield* releaseUnusedPins
          }).pipe(sql.withTransaction, Effect.catch(storageFailure))

          return yield* list
        }),

        remove: Effect.fn("SkillPacks.remove")(function* (name) {
          yield* Effect.gen(function* () {
            yield* sql`DELETE FROM skill_pack WHERE name = ${name}`
            yield* releaseUnusedPins
          }).pipe(sql.withTransaction, Effect.catch(storageFailure))

          return yield* list
        }),
      })
    }),
  )
}
