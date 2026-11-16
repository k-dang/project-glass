import {
  type ConversationSkillPack,
  type ConnectionError,
  InvalidSkillPackName,
  InvalidSkillPackUrl,
  isSkillPackName,
  shortSha,
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
import type { SkillSource } from "./agentHost/protocol"
import { GitHubClient } from "./github/GitHubClient"
import { type ArchiveFile, filesInArchive } from "./skillPackArchive"
import {
  filesBySkill,
  lastSegment,
  readSkill,
  skillFilePath,
  candidateSkillPackSources,
  suggestedName,
  claimFolder,
} from "./skillPackContents"

type PackFile = Omit<ArchiveFile, "contents">

interface PackSkill {
  readonly directory: string
  readonly skill: Skill
  readonly files: ReadonlyArray<PackFile>
}

interface ArchiveSkill extends PackSkill {
  readonly files: ReadonlyArray<ArchiveFile>
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

const decodeConversationPins = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String, pin_id: Schema.Int })),
)

const decodeConversationPacks = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      conversation_id: Schema.String,
      name: Schema.String,
      commit_sha: Schema.String,
    }),
  ),
)

const decodeSentFiles = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      path: Schema.String,
      executable: Schema.BooleanFromBit,
      contents: Schema.Uint8Array,
    }),
  ),
)

const repositoryLabel = ({ owner, repo }: SkillPackSource) => `${owner}/${repo}`

const atCommit = (source: SkillPackSource, commit: string) =>
  `${repositoryLabel(source)} at ${shortSha(commit)}`

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

const fileKey = ({ path, sha, executable }: PackFile) => `${path}\0${sha}\0${executable}`

const sameFiles = (a: ReadonlyArray<PackFile>, b: ReadonlyArray<PackFile>) =>
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
    readonly pinForConversation: (
      conversationId: string,
      names: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<ConversationSkillPack>, SkillPackNotFound | SkillPackError>
    readonly releaseConversation: (conversationId: string) => Effect.Effect<void, SkillPackError>
    readonly conversationPacks: Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<ConversationSkillPack>>,
      SkillPackError
    >
    readonly conversationSkills: (
      conversationId: string,
    ) => Effect.Effect<ReadonlyArray<SkillSource>, SkillPackError>
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

        const first = candidates[0]!

        return yield* new SkillPackNotReadable({
          message:
            first.ref === null
              ? `${repositoryLabel(first)} has no default branch.`
              : `GitHub has no branch, tag, or commit in ${repositoryLabel(first)} that this URL names.`,
        })
      })

      const read = Effect.fnUntraced(function* (source: SkillPackSource, commit: string) {
        const archive = yield* github.tarball(source, commit)

        const files = yield* filesInArchive(archive, source.path).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Couldn't read a Skill pack's archive", cause),
          ),
          Effect.mapError(
            () =>
              new SkillPackNotReadable({
                message: `GitHub sent a copy of ${folderLabel(source, commit)} that Glass couldn't read.`,
              }),
          ),
        )

        if (files === null) {
          return yield* new SkillPackNotReadable({
            message: `${atCommit(source, commit)} has no folder ${source.path}.`,
          })
        }

        const skillFiles = filesBySkill(files)

        if (skillFiles.size === 0) {
          return yield* new SkillPackNotReadable({
            message: `No folder in ${folderLabel(source, commit)} has a SKILL.md.`,
          })
        }

        const loaded = [...skillFiles].map(([directory, owned]) => {
          const skillFile = owned.find(({ path }) => path === skillFilePath(directory))!

          return {
            directory,
            owned,
            result: readSkill(directory, new TextDecoder().decode(skillFile.contents)),
          }
        })

        return {
          skills: loaded.flatMap(({ directory, owned, result }): Array<ArchiveSkill> =>
            result instanceof Skill ? [{ directory, files: owned, skill: result }] : [],
          ),
          skipped: loaded.flatMap(({ result }) => (result instanceof SkippedSkill ? [result] : [])),
        }
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

        const skillsByPin = Map.groupBy(skills, ({ pin_id }) => pin_id)

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
            skills: (skillsByPin.get(pack.pin_id) ?? []).map(
              ({ name, description }) => new Skill({ name, description }),
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

        if (existing !== undefined) {
          return existingPin(source, commit).pipe(
            Effect.flatMap((stillThere) =>
              stillThere === undefined
                ? Effect.fail(
                    new SkillPackError({
                      message: "Another change replaced this Skill pack's files. Try again.",
                    }),
                  )
                : Effect.succeed(stillThere),
            ),
          )
        }

        const { skills } = yield* read(source, commit)

        if (skills.length === 0) return yield* nothingToAdd(source, commit)

        const files = skills.flatMap((skill) => skill.files)

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
              files.map(({ path, sha, executable, contents }) => ({
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
        const used = sql`SELECT pin_id FROM skill_pack UNION SELECT pin_id FROM conversation_skill_pack`

        yield* sql`DELETE FROM skill_pack_skill WHERE pin_id NOT IN (${used})`
        yield* sql`DELETE FROM skill_pack_file WHERE pin_id NOT IN (${used})`
        yield* sql`DELETE FROM skill_pack_pin WHERE id NOT IN (${used})`
      })

      const sentSkills = Effect.fnUntraced(function* (name: string, pinId: number) {
        const files = yield* decodeSentFiles(
          yield* sql`SELECT path, executable, contents FROM skill_pack_file WHERE pin_id = ${pinId}`,
        )

        const taken = new Set<string>()

        return {
          name,
          skills: [...filesBySkill(files)].map(([directory, owned]) => {
            const inside = directory === "" ? 0 : directory.length + 1

            return {
              name: claimFolder(taken, directory === "" ? name : lastSegment(directory)),
              files: owned.map(({ path, executable, contents }) => ({
                path: path.slice(inside),
                executable,
                contents,
              })),
            }
          }),
        } satisfies SkillSource
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

          const bySkill = filesBySkill(files)

          return skills.map(({ directory, name, description }) => ({
            directory,
            skill: new Skill({ name, description }),
            files: bySkill.get(directory) ?? [],
          }))
        }).pipe(Effect.catch(storageFailure))

      return SkillPacks.of({
        list: Effect.fn("SkillPacks.list")(() => list),

        preview: Effect.fn("SkillPacks.preview")(function* (url) {
          const candidates = candidateSkillPackSources(url)

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

          const taken = sql`SELECT 1 FROM skill_pack WHERE name = ${name}`.pipe(
            Effect.map((rows) => rows.length > 0),
          )

          if (yield* taken.pipe(Effect.catch(storageFailure))) {
            return yield* new SkillPackNameTaken({ name })
          }

          const storePin = yield* preparePin(source, commit)

          yield* Effect.gen(function* () {
            if (yield* taken) return yield* new SkillPackNameTaken({ name })

            const pinId = yield* storePin

            return yield* sql`
              INSERT INTO skill_pack ${sql.insert({ name, ref: source.ref, pin_id: pinId })}
            `
          }).pipe(
            sql.withTransaction,
            Effect.catchIf(
              (error) => !(error instanceof SkillPackNameTaken || error instanceof SkillPackError),
              storageFailure,
            ),
          )

          return yield* list
        }),

        previewUpdate: Effect.fn("SkillPacks.previewUpdate")(function* (name) {
          const { pack, pinId } = yield* packNamed(name)

          const readLatest = Effect.gen(function* () {
            const latest = yield* resolve([pack.source])

            return { commit: latest.commit, contents: yield* read(pack.source, latest.commit) }
          })

          const [latest, current] = yield* Effect.all([readLatest, storedContents(pinId)], {
            concurrency: "unbounded",
          })

          const next = latest.contents
          const pinned = new Map(current.map((entry) => [entry.directory, entry]))
          const resolved = new Set(next.skills.map(({ directory }) => directory))

          return new SkillPackUpdate({
            name,
            from: pack.commit,
            to: latest.commit,
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
          }).pipe(
            sql.withTransaction,
            Effect.catchIf((error) => !(error instanceof SkillPackError), storageFailure),
          )

          return yield* list
        }),

        pinForConversation: Effect.fn("SkillPacks.pinForConversation")(
          function* (conversationId, names) {
            if (names.length === 0) return []

            const rows = yield* packRows
            const chosen = rows.filter(({ pack }) => names.includes(pack.name))
            const missing = names.find((name) => !chosen.some(({ pack }) => pack.name === name))

            if (missing !== undefined) return yield* new SkillPackNotFound({ name: missing })

            yield* sql`
            INSERT INTO conversation_skill_pack ${sql.insert(
              chosen.map(({ pack, pinId }) => ({
                conversation_id: conversationId,
                name: pack.name,
                pin_id: pinId,
              })),
            )}
          `.pipe(Effect.catch(storageFailure))

            return chosen.map(({ pack }) => ({ name: pack.name, commit: pack.commit }))
          },
        ),

        releaseConversation: (conversationId) =>
          Effect.gen(function* () {
            yield* sql`DELETE FROM conversation_skill_pack WHERE conversation_id = ${conversationId}`
            yield* releaseUnusedPins
          }).pipe(Effect.catch(storageFailure)),

        conversationPacks: sql`
            SELECT assigned.conversation_id, assigned.name, pin.commit_sha
            FROM conversation_skill_pack AS assigned JOIN skill_pack_pin AS pin ON pin.id = assigned.pin_id
            ORDER BY assigned.name
          `.pipe(
          Effect.flatMap(decodeConversationPacks),
          Effect.map(
            (rows) =>
              new Map(
                [...Map.groupBy(rows, ({ conversation_id }) => conversation_id)].map(
                  ([conversationId, packs]) => [
                    conversationId,
                    packs.map(({ name, commit_sha }) => ({ name, commit: commit_sha })),
                  ],
                ),
              ),
          ),
          Effect.catch(storageFailure),
        ),

        conversationSkills: Effect.fn("SkillPacks.conversationSkills")(function* (conversationId) {
          return yield* sql`
            SELECT name, pin_id FROM conversation_skill_pack WHERE conversation_id = ${conversationId} ORDER BY name
          `.pipe(
            Effect.flatMap(decodeConversationPins),
            Effect.flatMap((pins) =>
              Effect.forEach(pins, ({ name, pin_id }) => sentSkills(name, pin_id)),
            ),
            Effect.catch(storageFailure),
          )
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
