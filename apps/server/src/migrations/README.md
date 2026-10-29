# Database migrations

Each database change gets a numbered TypeScript file exporting an Effect. Import it
statically and register it in `../Migrations.ts` with the same `<number>_<name>` key.
Choose a number higher than every existing migration; resolve collisions when rebasing.
Never edit, rename, or remove a migration that has shipped. Corrections get a new migration.

`DatabaseLive` runs pending migrations automatically before dependent backend services
are available. Effect tracks completed IDs in `effect_sql_migrations` and applies the
pending batch in a transaction. A failure rolls back that batch and fails startup.

Fresh installs and upgrades use the same migration sequence. Test changes against a
populated previous schema, checking that existing data survives. Use temporary databases.
Reverting app code does not reverse a committed migration; migrations only run forward.
