# Where the user is lives in the URL; shared state lives in Effect atoms

The renderer routes with TanStack Router over hash history (`glass://app/index.html#/…`), with
routes declared in code in `apps/desktop/src/renderer/routes.tsx`. Where the user is goes in the
address: the area, the open PR (`#/reviews/<owner>/<repo>/<number>`), and the PR list's view as
search params (`?list=&view=`). Search params are parsed with
Effect Schemas through Standard Schema, falling back to defaults rather than failing on bad input,
and default values are stripped from the address. So Back to PRs, browser Back and Forward, and a
window reload all land where the user was, and each new feature adds a route rather than another
piece of `App` state.

State that outlives a component or is read in more than one place (the GitHub connection, followed
repositories, the open PR workspace and its tab and file, the remembered list and view) is held in
Effect atoms (`effect/reactivity`) and read with `@effect/atom-react`. Each component subscribes
to the atoms it reads, so a change re-renders only those components. Queries are
`backendRuntime.atom(...)`, refreshed for Retry; mutations and the PR open and Reload are
`backendRuntime.fn(...)`, whose result keeps the previous value while a new run is waiting and
interrupts the run it replaces. Every backend call goes through that one atom runtime, built from
`backendLayerAtom` in `backend.ts`, so the app holds one RPC socket; tests seed `backendLayerAtom`
with a test layer through `RegistryProvider`'s `initialValues`.

Unsent work does not live in the router or in components. The open PR workspace and its Draft,
Reply, and viewed-file stores live in a kept-alive atom (`reviewsArea.ts`), so leaving Reviews for
another area unmounts the workspace without losing anything, and returning rebuilds it from the
atom and the address. The router carries the atom registry in its context, and the Reviews routes
drive the atoms: the PR route's `beforeLoad` opens its PR, replacing any other, and entering the
list route closes it. A router blocker in the app shell guards the open PR from wherever the user
is: going to the list or another PR saves pending Drafts and asks before discarding unsent
feedback. State that must survive an unmount, such as a Review GitHub may already have accepted,
belongs in those stores, not in component state.

## Considered Options

- **Extend the hand-rolled hash router**: least code now, but every route would rebuild search-param
  validation, typed links, defaults, and navigation blocking by hand.
- **Keep Reviews mounted and hidden while another area shows**: keeps scroll and every component's
  state, but the PR isn't driven by its route and each new area inherits the special case.
- **The PR's tab and file in the address**: survives a reload, but the workspace kept local state,
  mirrored it into the URL with an effect, and copied the URL into an atom for the Reviews link:
  three copies of one fact.
- **Route loaders for opening a PR**: the router's match cache would hold the workspace, whose
  lifetime (unsent work, confirm before discard) is not a cache's.
- **File-based routes**: idiomatic at scale, but needs the router's Vite plugin and generated code
  for a handful of routes. Revisit when the route count grows.
- **React context plus `useState` in `App`** for shared state: one prop path, but every change
  re-renders every consumer, and each feature adds more state to `App`.
- **Hand-written external stores or Zustand**: granular, but async status, retry, and cancellation
  for Effect calls would still be hand-built.

## Consequences

Returning from another area rebuilds the workspace view, so diff scroll, collapsed files, and the
split or unified choice start over; the tab and file come back from `workspaceViewAtom`, which
opening a different PR resets. They stay out of the address because scrolling the diff changes the
file constantly and the workspace's handlers scroll right after switching tabs, which needs the
change applied synchronously; navigation isn't. A window reload restores the matching Saved place
when its GitHub identity and Revision still match; a changed Revision opens Overview with a notice.
SQLite keeps one Saved place per area, each the latest resumable destination there with a
feature-owned position. Settings and Activity leave them unchanged. The Files tab's selected repository file also
lives in the workspace atom. Position writes are ordered, with superseded pending positions skipped;
the Activity log remains history rather than the source of the current position. The destination
carries the identity from its loaded workspace, so saving a position stays local and works when
GitHub is unavailable; the backend stamps only the save time.

Continue reads the current in-memory destination for each area as soon as work changes; a
persistence response never replaces it. Dashboard owns the Continue cards: the last PR first, then
the newest Saved place from any other area. Visiting Dashboard leaves every Saved place unchanged.
The stored destinations seed a fresh renderer until work is opened in their area. Each diff
or Tour viewer applies its initial file when it mounts, including when a Tour arrives after the
workspace. Scroll callbacks report position only after that viewer applies its initial position.

The per-PR Draft, Reply, and viewed-file stores stay classes with autosave timers, held by the
workspace atom and given a `BackendRuntime` from the registry with `backendRuntimeOf`. The PR list
keeps its paging in component state, because it reloads whenever the list is shown. Async state
renders from `AsyncResult` throughout, with `problemOf` turning a failure's cause into the alert.
Followed repositories load when Settings first needs them, not at launch.
