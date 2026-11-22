# Browser panes are webviews, and agents drive them with Playwright

A Thread's agent drives the same page the user sees in its Browser pane, often while the user is
looking at another Thread. So each Browser pane's page is a `<webview>` kept mounted in one layer
of the window, outside any Thread's view, and placed over its Thread's pane while that Thread is
on screen. It stays alive while its Thread is on screen or its agent's Turn is running. The
agent's browser tools are Glass tools answered by the backend (ADR 0013), which drives the page
with Playwright's `connectOverCDP`. Electron allows one debugger per page, so main holds that
attachment and serves a relay over it on a loopback WebSocket at a secret path. The relay answers
the few browser-level `Target.*` and `Browser.*` commands Playwright sends for its one page and
forwards the rest. It reaches Browser pane pages only, never Glass's own window, which holds the
backend's secret.

Opening DevTools on a page takes its one debugger, so the agent's browser tools fail while
DevTools is open, and the relay attaches again when it closes.

## Considered options

- **A `WebContentsView` owned by main**: Electron's recommended replacement for `<webview>`, but
  it draws over the whole window, so no Glass UI can sit over the page: not the Feedback note
  editor, the Command menu, menus, toasts, or dialogs.
- **A `<webview>` inside the Thread's view**: simplest, but its page dies when the user switches
  Threads, so the agent couldn't use the browser meanwhile.
- **The tools on raw CDP in main, without Playwright**: no relay and no Playwright dependency, but
  every tool would need its own element ids, waiting, frame handling, dialogs, and uploads, which
  Playwright already has.
- **Electron's `--remote-debugging-port`**: no relay, but any process on this device could drive
  every page, including Glass's own window.
- **Microsoft's `@playwright/mcp` against the relay**: more tools for free, but it runs as the
  agent's own MCP server, outside Glass's tools, so Glass couldn't take control of the page away
  from the agent when the user takes over.
- **T3 Code's full relay**: it also splits screencast frames between viewers, which Glass doesn't
  need because it streams no pages.
