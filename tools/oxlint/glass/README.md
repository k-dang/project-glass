# Glass boundary and wait checks

`pnpm check` runs `glass/architecture` and `glass/test-waits` through the root
Vite+/Oxlint configuration.

## Imports

[architecture.ts](architecture.ts) checks import/export declarations, literal dynamic
imports, import types, TypeScript import-equals, and unshadowed literal `require` calls
(including template literals without substitutions). Oxc Resolver resolves
relative paths, TypeScript `paths` (including the renderer's `@/`), package exports,
and symlinks before checking the destination. Existing paths are canonicalized so
Windows casing differences cannot bypass a boundary. `.js` specifiers resolve TypeScript
source as in the app's bundler configuration.

- Production renderer code cannot import server, main, preload or test implementations,
  Electron, or Node builtins (including bare names such as `fs/promises`). Use
  `@glass/contracts` and the renderer RPC client.
- Contracts cannot import anything under `apps/`.
- Backend production code cannot import the transport entry points listed in
  `entryPoints`, or runtime HTTP/RPC implementations, unless it is a named transport
  owner. This reserves transport imports explicitly rather than treating every Effect
  service or every file in a subdirectory as domain logic.

Transport owners are `bin.ts`, `server.ts`, `handlers.ts`, `access.ts`, `agentHost.ts`,
`agentHost/handlers.ts`, `agentHost/server.ts`, `rpcSocket.ts`, `LocalAgentHost.ts`, and `sandboxCalls.ts`
under `apps/server/src/`. The last two are connection adapters that services may call;
other code cannot import the entry points or socket implementation directly.
`github/GitHubClient.ts` may import the named outbound Effect HTTP client modules in
`httpClient`, but cannot import inbound routing/server implementations.

External type-only imports remain valid. Runtime RPC schema/error modules (`Rpc`,
`RpcGroup`, `RpcSchema`, `RpcMessage`, `RpcClientError`) and HTTP error/method modules
(`HttpClientError`, `HttpServerError`, `HttpMethod`) remain available, including the
Agent host's protocol definitions. Namespace runtime transport imports are rejected
because they expose implementation APIs too. Effect HTTP, HTTP API, RPC, Node HTTP,
and the Node platform's HTTP exports are covered.

`*.test.*`, `*.spec.*`, and files under `apps/*/test/` or `apps/*/e2e/` may import across
tiers. This preserves fixtures such as `apps/desktop/e2e/glass.ts`. Production renderer
code cannot use those fixtures as an import bridge.

## Test waits

[test-waits.ts](test-waits.ts) checks tests and app test/e2e helpers for:

- Direct `vi.waitFor`/`vitest.waitFor` from `vitest`, `vite-plus/test`, or `@effect/vitest`,
  including renamed imports, namespace imports, static property access, and immutable local aliases or
  destructuring. Unshadowed global `vi`/`vitest` are covered too. Diagnostics point to
  that app's `test/eventually.ts`, and desktop DOM tests to Testing Library's `waitFor`.
- Directly awaited/yielded `Effect.sleep` or Node `timers/promises.setTimeout` calls,
  including import/local aliases. These forms sequence work by waiting on time.
- Directly awaited/yielded Promises whose executor only schedules a native/Node
  `setTimeout`, passing its resolver or a zero-argument arrow that only calls that
  resolver. These are recognizable Promise sleeps; event waits with fallback timers
  remain valid.

The exact files `apps/desktop/test/eventually.ts` and `apps/server/test/eventually.ts`
are exempt: they own the generous polling limit and native polling timer. Scheduled
fake responses, timeout configuration, fake timer advancement and `TestClock.adjust`
remain valid. Forked simulated work may contain sleeps; tests can wait for it to become
stuck and then advance the clock.

These checks prevent the short-default Vitest wait removed from Discussions by
`3511ddf`, without blocking the clock-controlled deadline tests from `86fe313`.
Testing Library's `waitFor` is the desktop DOM tests' wait and is outside this rule; its
generous limit comes from `asyncUtilTimeout` in `apps/desktop/test/setup.ts`. It needs a DOM,
so tests in the Node environment use `eventually`.

## Review still required

The rules inspect static imports and local binding syntax, not arbitrary data flow.
Computed module names, user-defined wait wrappers, re-exported test APIs, reassigned
aliases, and composed/piped sleeps need review. Unresolved imports remain the type
checker's responsibility. Vite-only aliases must also be represented in TypeScript
`paths` to participate in this resolver; the current `@/` alias is.

Handler thickness, `it.live` versus `it.effect`, observable progress before advancing
the clock, success-path deadlines, and elapsed-time assertions still need review;
follow [AGENTS.md](../../../AGENTS.md). The lint does not infer these from timeout values.
