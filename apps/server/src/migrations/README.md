# Database migrations

Each database change gets a numbered TypeScript file exporting an Effect. Import it
statically and register it in `../Migrations.ts` with the same `<number>_<name>` key.
Choose a number higher than every existing migration; resolve collisions when rebasing.
Never edit, rename, or remove a migration that has shipped. Corrections get a new migration.

`DatabaseLive` runs pending migrations automatically before dependent backend services
are available. Effect tracks completed IDs in `effect_sql_migrations` and applies the
pending batch in a transaction. A failure rolls back that batch and fails startup.

Fresh installs and upgrades use the same migration sequence. Before merging a migration,
check it against a populated copy of the previous schema in a temporary database, making
sure existing data survives. Don't keep that check as a test: Glass has one user, so once
their database has run a migration, no database is left for the test to protect.
Reverting app code does not reverse a committed migration; migrations only run forward.
