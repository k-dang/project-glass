import { NodeServices } from "@effect/platform-node"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { FollowedRepository } from "@glass/contracts"
import { Effect, Layer } from "effect"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitIn, seedClone } from "../test/gitRepositories"
import { overlappingGit } from "../test/overlappingGit"
import { LocalCheckouts } from "./LocalCheckouts"
import { migrationLoader } from "./Migrations"

const repository = new FollowedRepository({ owner: "glass-demo", repo: "checkout" })

it.effect("lists the remote branches while it finds the remote's default branch", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "glass-checkouts-")))
    const { checkout } = seedClone(directory, repository.owner, repository.repo)
    gitIn(checkout, "remote", "set-head", "origin", "develop")

    const checkouts = yield* LocalCheckouts
    yield* checkouts.link(checkout)

    const { defaultBranch, branches } = yield* checkouts.branches(repository)

    assert.equal(defaultBranch, "develop")
    assert.sameMembers([...branches], ["main", "develop"])
  }).pipe(
    Effect.provide(
      LocalCheckouts.layer.pipe(
        Layer.provide(overlappingGit(["for-each-ref", "symbolic-ref"])),
        Layer.provide(
          SqliteMigrator.layer({ loader: migrationLoader }).pipe(
            Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
          ),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
)
