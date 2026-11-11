import { SqliteMigrator } from "@effect/sql-sqlite-node"
import baseline from "./migrations/0001_baseline"

export const migrationLoader = SqliteMigrator.fromRecord({ "0001_baseline": baseline })
