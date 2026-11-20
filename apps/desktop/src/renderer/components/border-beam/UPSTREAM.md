# Upstream

- Source: https://github.com/Jakubantalik/Libraries.dev, `packages/border-beam/src/` (v1.4.1)
- Commit: `f14340a2ad05ad6e81d8d8f319a68ca8a907d480`
- License: MIT; see [`LICENSE`](LICENSE).
- Vendored so Glass owns the beam around the agent composer.

## Local deviations

- Non-null assertions on fixed-table indexing in `styles.ts` for `noUncheckedIndexedAccess`.
- `GenerateStylesOptions`'s optional props take `| undefined` for `exactOptionalPropertyTypes`.
- Only `src/` is vendored; the spec, extraction script and native ports are left out.
- `BorderBeam.tsx` derives its active/fading state during render and reads the system theme with `useSyncExternalStore` instead of syncing them in effects.
- The formatter's quotes, semicolons and blank lines.
- Glass's own comments are left out; upstream's are kept so syncs stay easy. Oxlint rules that would force rewriting upstream code are turned off for this folder in the root `vite.config.ts`.
