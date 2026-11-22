# Browser pane

A Thread's Browser pane shows a web page beside the Chat. The user opens it from the Thread's Details (Browser) or the Command menu (Open Browser), by clicking a `localhost` link in a local Thread's transcript, or by clicking an HTML file the agent named. It has an address bar, Previous page, Next page, Reload, Open in your browser, and Open DevTools, and it remembers each Thread's last address on this device. Pop-ups open in their own window. A Sandbox Thread's pane refuses addresses on this device and its pages can't reach them.

## Sub-features

- Typing an address loads it; `localhost:3000` becomes `http://`, anything else `https://`; `file:` and other schemes are refused.
- A `localhost` link in a local Thread's transcript opens in the pane; in a Sandbox Thread it does not.
- An HTML file named by the agent loads from the Thread's folder, and reloads when the next Turn ends.
- Reopening the pane on the same Thread shows the last address.
- A Sandbox Thread's pane shows "This Thread's apps run in its Sandbox" for a loopback address, and its pages' requests to this device never arrive.

## How to get to it (user POV)

Open a Thread, open Details, and choose Browser; or click a `localhost` link in the agent's reply.

## Driving it with glass-verify

1. Serve a page on this device, e.g. `python3 -m http.server 47321 --bind 127.0.0.1` in a scratch folder holding an `index.html` with a link and a `target="_blank"` link. `node $V launch --backend fake`, doctor.
2. Open the seeded pi Thread ("Show me around this repository."). Send `The app is at [the app](http://localhost:47321/)`. The demo agent echoes the message, so its reply holds a link: `click --role link --name "the app"`. The pane opens on the page. Screenshot.
3. `type --role textbox --name Address --text "localhost:47321"`, `press --key Enter`. Follow a link with raw CDP on the `webview` target (see Feedback notes on a page), then `Previous page` and `Next page`.
4. Click the pop-up link: `/json/list` gains a `page` target for it, without a `glass-page-notes` element.
5. New Thread, Where the Thread runs: `Fake Sandboxes`, send `Say hello`, `wait --text "Fake reply"`. Open Browser and type `localhost:47321`: `wait --text "run in its Sandbox"`. Load `example.com`, then `Runtime.evaluate` a `fetch('http://localhost:47321/')` on its `webview` target: it fails, and the server logs no request.

## Gotchas

- Glass's window has its own Back and Forward buttons; the pane's are Previous page and Next page.
- The page itself is outside the window's accessibility tree; `wait --text` doesn't see its text, only the pane's heading and address.
- A Sandbox link to `localhost` goes to the system browser; don't click it in a run on your own machine unless you want that.
