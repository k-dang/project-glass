# Where the user is lives in the URL; shared state lives in Effect atoms

Where the user is goes in the address, through TanStack Router over hash history: the area, the open
PR, and the PR list's view. So Back to PRs, browser Back and Forward, and a window reload all land
where the user was, and each new feature adds a route rather than another piece of `App` state.

State that outlives a component or is read in more than one place is held in Effect atoms
(`effect/reactivity`), so a change re-renders only the components that read it. Every backend call
goes through one atom runtime, so the app holds one RPC socket.

Unsent work does not live in the router or in components. The open PR workspace and its stores live
in a kept-alive atom, so leaving Reviews unmounts the workspace without losing anything, and
returning rebuilds it from the atom and the address. The routes drive that atom, opening and closing
the PR, and a router blocker in the app shell guards unsent work from wherever the user is. State
that must survive an unmount, such as a Review GitHub may already have accepted, belongs in those
stores, not in component state.

## Considered Options

- **Extend the hand-rolled hash router**: least code now, but every route would rebuild search-param
  validation, typed links, defaults, and navigation blocking by hand.
- **Keep Reviews mounted and hidden while another area shows**: keeps scroll and every component's
  state, but the PR isn't driven by its route and each new area inherits the special case.
- **The PR's tab and file in the address**: survives a reload, but the workspace kept local state,
  mirrored it into the URL with an effect, and copied the URL into an atom for the Reviews link:
  three copies of one fact. Scrolling the diff also changes the file constantly, and the workspace's
  handlers scroll right after switching tabs, which needs the change applied synchronously;
  navigation isn't.
- **Route loaders for opening a PR**: the router's match cache would hold the workspace, whose
  lifetime (unsent work, confirm before discard) is not a cache's.
- **File-based routes**: idiomatic at scale, but needs the router's Vite plugin and generated code
  for a handful of routes.
- **React context plus `useState` in `App`** for shared state: one prop path, but every change
  re-renders every consumer, and each feature adds more state to `App`.
- **Hand-written external stores or Zustand**: granular, but async status, retry, and cancellation
  for Effect calls would still be hand-built.

## Consequences

Returning from another area rebuilds the workspace view, so diff scroll, collapsed files, and the
split or unified choice start over.

## Revisit when

- The route count grows enough to justify file-based routes.
- A tab or file needs its own address, such as a link to share, despite the scroll problem above.
- Shared state stops being mostly Effect calls, which would weaken the case for atoms.
