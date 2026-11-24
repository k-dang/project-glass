# Visualizations are sandboxed pages shown inline, served from a copy Glass keeps

An agent shows a Visualization with the `show_visualization` Glass tool, passing either the page's
HTML or a path to an `.html` file in its Thread's folder. The backend answers it (ADR 0015): it
reads the file and any local images the page names through the Thread's agent host, so it works the
same on this device and in a Sandbox, inlines the images, and keeps the finished page in its
database. The tool call's result holds only the Visualization's id, and the page stays as it was
when shown, however the file changes after. Inline HTML is also kept in the tool call's input, like
any tool call's arguments.

The page is the agent's own HTML and scripts, and Glass's window holds the backend's secret, so the
page runs in a frame sandboxed to an opaque origin. Main serves it at `glass-visualization://<id>`,
fetching it from the backend with the secret added there, so the page never sees it in its own
address. The page's Content Security Policy lets it load scripts, styles and images over https but
make no requests, and main refuses its loads from this device, as it does a Sandbox Browser pane's,
so a Sandbox Thread's page can't reach this device. A small script Glass adds to
the page takes the app's theme as CSS variables, reports the page's height so the frame fits it, and
hands link clicks to Glass.

## Considered options

- **A host tool like `draw_diagram`, with the HTML in the tool call**: nothing to store, but a page
  from a file would change or vanish with the file, and local images would have no place to live.
- **The Browser pane**: it already shows a Thread's HTML files, but beside the Thread rather than in
  the reply, one page at a time, and the page there is live rather than as shown.
- **A `srcdoc` or `blob:` frame**: no scheme to serve it, but such a frame inherits the window's
  Content Security Policy, which blocks the page's inline scripts.
- **Pages measured and previewed by a headless browser, kept as attachment files**: headless Chrome
  measures each page at several widths and screenshots it for the agent, and pages are served behind
  expiring URLs. Glass has one desktop client, so the frame measures the live page and the copy
  lives in SQLite.

## Consequences

- The agent can't check a page before showing it; a broken page shows broken, and the agent sees
  only Glass's refusals, such as a page with viewport height units.
- Fonts the app bundles don't reach the page, so a theme's font falls back to the system's.
