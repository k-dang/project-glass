# Upstream

- Source: https://github.com/shadcn-ui/ui, `packages/react/src/message-scroller/`
- Commit: `968d8cb9dc42ae5d52e8fd356cf84596ec832a26`
- License: MIT; see [`LICENSE`](LICENSE).
- Vendored so Glass can change how the transcript scrolls.

## Local deviations

- `useHoldScrollPosition`, `holdPosition` and the `"holding-position"` mode keep the viewport still while a disclosure in the transcript opens or closes, until the reader scrolls, jumps, or a new turn anchors. The controller's comment on deliberate gestures also lists the held position.
- With `autoScroll`, a new scroll anchor leaves the reader in place once they have scrolled away (`"free-scrolling"`), instead of jumping to it.
- Base UI's `mergeProps`/`useRender` replace upstream's copy, and `assignRef` replaces `composeRefs`.
- Optional props take `| undefined` for `exactOptionalPropertyTypes`.
- Tests run in happy-dom.
- The formatter's blank lines.
- Glass's own comments are left out; upstream's are kept so syncs stay easy. Oxlint rules that would force rewriting upstream code are turned off for this folder in the root `vite.config.ts`.
