# Browser pane

A Thread's Browser pane shows a web page beside the Chat. The user opens it from the Thread's Details (Browser) or the Command menu (Open Browser), by clicking a `localhost` link in a local Thread's transcript, or by clicking an HTML file the agent named. It has an address bar, Previous page, Next page, Reload, Open in your browser, and Open DevTools, and it remembers each Thread's last address on this device. Pop-ups open in their own window. A Sandbox Thread's pane refuses addresses on this device, and its pages can't reach this device or a private network. A pane loads only Thread files of the place it runs in, and a page can read only its own Thread's files. A local Thread's agent opens, reads, acts on, and screenshots the same page; the pane says "Agent is using the browser" while it does, and a click or keypress in the page takes over the browser until the user hands it back or sends the Thread their next message.

## Sub-features

- Typing an address loads it; `localhost:3000` becomes `http://`, anything else `https://`; `file:` and other schemes are refused.
- A `localhost` link in a local Thread's transcript opens in the pane; in a Sandbox Thread it does not.
- An HTML file named by the agent loads from the Thread's folder, and reloads when the next Turn ends.
- Reopening the pane on the same Thread shows the last address.
- A Sandbox Thread's pane shows "This Thread's apps run in its Sandbox" for a loopback address, and its pages' requests to this device, its LAN or Tailscale addresses, or a name resolving to one never arrive (`net::ERR_SOCKS_CONNECTION_FAILED`).
- A page's `fetch` of another Thread's `glass-file://` address fails; opening a local Thread's file in a Sandbox pane, or the reverse, shows "This Thread is gone."
- The agent's `act_in_browser` clicks, types, presses keys, and scrolls by `read_browser` refs; its keys reach the page, never Glass's Message box. In a frame from another site it can click but refuses to type or press keys.
- "Agent is using the browser" shows while one of the agent's browser tool calls runs.
- A click in the page during the agent's Turn shows "You took over the browser." and Hand back to agent; until then the agent's `open_browser` and `act_in_browser` fail with "The user took over the browser", while `read_browser`, `screenshot_browser`, and `browser_console` work. An `open_browser` still loading when the user takes over fails and the page stays where it was.
- Hand back to agent, or the user's next message, returns the browser to the agent.

## How to get to it (user POV)

Open a Thread, open Details, and choose Browser; or click a `localhost` link in the agent's reply.

## Driving it with glass-verify

1. Serve a page on this device, e.g. `python3 -m http.server 47321 --bind 127.0.0.1` in a scratch folder holding an `index.html` with a link and a `target="_blank"` link. `node $V launch --backend fake`, doctor.
2. Open the seeded pi Thread ("Show me around this repository."). Send `The app is at [the app](http://localhost:47321/)`. The demo agent echoes the message, so its reply holds a link: `click --role link --name "the app"`. The pane opens on the page. Screenshot.
3. `type --role textbox --name Address --text "localhost:47321"`, `press --key Enter`. Follow a link with raw CDP on the `webview` target (see Feedback notes on a page), then `Previous page` and `Next page`.
4. Click the pop-up link: `/json/list` gains a `page` target for it, without a `glass-page-notes` element.
5. New Thread, Where the Thread runs: `Fake Sandboxes`, send `Say hello`, `wait --text "Fake reply"`. Open Browser and type `localhost:47321`: `wait --text "run in its Sandbox"`. Load `wikipedia.org`, then raw CDP `Page.navigate` the `webview` target to `http://<this device's LAN address>:47321/`: it fails with `net::ERR_SOCKS_CONNECTION_FAILED`, and the server logs no request. A `fetch` from an https page can't test this, since mixed content blocks it first.

6. Agent tools, on the local demo Thread: serve a page with a form and a route that answers after about 8 seconds. Send `call:<tool> <json>` messages; the demo model runs one tool call per `call:` line, in order, within one Turn, and replies with what each returned. `call:open_browser {"url":"http://127.0.0.1:<port>/"}` then `call:read_browser {}` for refs; expand the read's tool row to see them all. `call:act_in_browser {"action":"type","ref":"e5","text":"Ada"}` and `{"action":"click","ref":"e6"}`; confirm with `Runtime.evaluate` on the `webview` target.
7. Take over: send a Turn that starts with `open_browser` on the slow route followed by `open_browser`, `act_in_browser`, `read_browser`, `browser_console`, and `screenshot_browser`. `wait --text "Agent is using the browser"`, then dispatch a raw CDP mouse click on the window target at a point inside the page, computed before the Turn. `wait --text "Hand back to agent"`. Expanding the Turn shows the slow `open_browser` and the acting calls after it Failed, the reads Done, and the page still on its first address. Click Hand back to agent, or send the next message mid-Turn, and the bar goes.

## Gotchas

- Glass's window has its own Back and Forward buttons; the pane's are Previous page and Next page.
- The page itself is outside the window's accessibility tree; `wait --text` doesn't see its text, only the pane's heading and address.
- `example.com` may not resolve on this machine; use `wikipedia.org` for a public page.
- A Sandbox link to `localhost` goes to the system browser; don't click it in a run on your own machine unless you want that.
- The page's own `Runtime.evaluate` fails while it navigates, so compute click points beforehand; a click during the agent's own typing counts as the agent's and doesn't take over.
- A click after the Turn ends takes nothing: the agent isn't using the browser then, and the next message hands it back anyway.
- `screenshot_browser` returns an image, which pi passes back as a user message, so the demo model stops after it; put it last.
- Refs change whenever the page loads and can gain a frame prefix, such as `f6e5`; read again before acting, and expand the read's tool row for the full snapshot.
