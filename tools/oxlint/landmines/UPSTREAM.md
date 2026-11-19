# Upstream

- Source: https://github.com/interfere-inc/landmines, `packages/landmines/src/`
- Commit: `79e91992952c14b0c217b403fa416024c1929afe` (`@interfere/landmines` 0.1.1)
- Installed: 2026-11-18, vendored because every published release was younger than the workspace `minimumReleaseAge`
- Plugins: `plugins/testing.ts`, `plugins/style.ts` and `plugins/structure.ts`, registered in the root `vite.config.ts`
- License: MIT; see [`LICENSE`](LICENSE).

## Local deviations

- Dropped `no-test-doubles` and `no-fixed-sleep`. Glass keeps `anti-slop/no-module-mocking` and `glass/test-waits` for those jobs.
- Dropped `strict-msw`, since Glass doesn't use MSW, and `no-unsignaled-poll`, since `glass/test-waits` already bans direct `vi.waitFor`. `allowlistProperties` is no longer exported.
- Dropped `landmines-types` and its `no-explicit-return-types`. Glass's return types keep literal tags from widening, pin Effect error channels, and type recursive functions.
- Dropped `colocated-tests` and its `lib/test-owner.ts`. It can't see a subject reached through a `test/` harness, which is how most Glass tests reach theirs, so it guessed owners from incidental imports. `packageDirectory` moved to `lib/package-directory.ts`.
- Allowlist `stale` messages name `vite.config.ts`, where Glass configures Oxlint, instead of `.oxlintrc.jsonc`.
- `no-flake-masking` doesn't check the `test` block of Vite configs: a package-wide time limit is Glass policy, not a masked flake. It still checks per-test timeouts and `vi.setConfig`.
- `no-comments` also accepts the `@vitest-environment` directive.
- Upstream tests are not vendored.

## Updates

Stage an explicit upstream revision, compare it with the commit above, and port reviewed changes into this tree, preserving the deviations. Update this record when the source or deviations change.
