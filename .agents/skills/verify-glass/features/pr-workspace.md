# PR workspace

The user opens a PR from the [PR list](./pr-list.md) or pastes its GitHub URL into the form above that list and chooses Open. `Back to PRs` in the workspace header, or Escape when no menu, dialog, or text field is taking it, closes the PR and returns to the list. From a workspace, `Open another PR` (the icon left of "Head") or ⌘L (Ctrl+L) opens a dialog that takes a URL or `owner/repo#number`. An open PR's address is `#/reviews/<owner>/<repo>/<number>`. The page shows the repository, the title and number, a state badge (Open, Draft, Closed, Merged), the author, the base and head branches, and the description as GitHub renders it. The workspace is pinned: "Head <sha>" shows the first seven characters of the head commit and stays put when the PR gets new commits, until the user chooses Reload. Text that isn't a PR URL leaves Open disabled; a PR that doesn't exist or can't be seen, and access GitHub refuses, each show their own alert with Back to PRs and Try again.

## Sub-features

- `pr-open` opens a PR from its URL, including `/files`-style tab URLs and URLs without `https://`.
- `pr-description` renders the description like GitHub: lists with markers, code, links, and images. An empty description reads "No description provided."
- `pr-images` opens description images in a modal gallery with click, wheel, and keyboard zoom, drag panning, Fit, and previous/next navigation. Zoom shortcuts work from every viewer control; gallery buttons retain focus when activated. Escape, Close, or the backdrop dismisses it and returns focus to the opening image. Comments and Reviews have their own galleries.
- `pr-pinned` shows "Head <short sha>" matching the PR's head commit when it was opened.
- `pr-reload` moves the pin to the PR's current head on Reload.
- `pr-switch` opens another PR from a workspace through the `Open a PR` dialog, from its button or ⌘L; Escape closes it.
- `pr-invalid` leaves Open disabled for text that isn't a PR URL or owner/repo#number.
- `pr-not-found` shows "Pull request not found" with "<owner>/<repo>#<n> doesn't exist, or your GitHub token can't see it."
- `pr-denied` shows "GitHub denied access to <owner>/<repo>" with GitHub's reason, e.g. SAML enforcement.
- `pr-links` opens ordinary description links, including linked badges and GitHub file/directory pages, in the default browser. Image links open the gallery; modifier clicks retain the original link behavior. The Glass window never navigates away.

## How to get to it (user POV)

- Paste a URL into the `Pull request URL` field above the PR list in Reviews and choose `Open` (or press Enter).
- With a PR open, choose `Open another PR` or press ⌘L, paste a URL, and press Enter.
- Choose `Reload` at the top right of an open workspace.

## Driving it with glass-verify

Preconditions:

- A real-GitHub run (`node $V launch`) signed in with a token that can read public repos; `node $V doctor` passes.
- For `pr-reload`, push access to the kept probe repo `k-dang/glass-api-probe` (PR #1, branch `change`).

- **Open (`pr-open`, `pr-pinned`).** `node $V type --role textbox --name "Open a PR" --text "https://github.com/k-dang/glass-api-probe/pull/1"`, `node $V click --role button --name "Open"`, `node $V wait --text "Reload"`, then snapshot and screenshot. "Head <sha>" matches `gh pr view 1 -R k-dang/glass-api-probe --json headRefOid`.
- **Switch (`pr-switch`).** With a PR open, `click --role button --name "Open another PR"` (or send ⌘L as raw CDP `Input.dispatchKeyEvent`: `rawKeyDown` then `keyUp`, `key: "l"`, `code: "KeyL"`, `modifiers: 4`). The snapshot shows `dialog "Open a PR"`. `type --role textbox --name "Open a PR"` another PR's `owner/repo#number`, press Enter over CDP, and `wait --text` its title.
- **Description (`pr-description`).** Open a PR with a rich description, e.g. `https://github.com/pingdotgg/t3code/pull/18124` (images) or `/pull/18143` (bulleted list). Look at the screenshot: bullets show, images load, code spans are styled.
- **Images (`pr-images`).** Open `https://github.com/k-dang/project-glass/pull/65`, snapshot and screenshot the description, then `node $V click --role button --name "Preview Before"`. Capture the `Before` dialog and its `1 / 4` counter. Click `Zoom in`; screenshot the enlarged image. Drag it using raw CDP pointer events at the zoomable image button's bounds and check its scroll position changes. `Fit` restores the whole image; `Next image` shows `After` with `2 / 4`. Use raw CDP key events to verify plus/minus/0 zoom, arrow navigation at fit and panning with overflow, and Escape returning focus to `Preview Before`. Reopen and click the backdrop to dismiss. Check `location.href` still identifies the same PR throughout.
- **Viewer controls and anchoring (`pr-images`).** Tab to Previous image, Next image, and Close; plus/minus/0 still change zoom without moving focus. Activate Next image twice with Enter: the gallery advances twice and focus stays on Next image. At fit, record the image bounds and a pointer position inside it. Wheel-zoom by 1.5× (`deltaY = -Math.log(1.5) / 0.002` over raw CDP): once scrollbars appear, the image stays 1.5× as large and its point under the pointer stays within two pixels. Fit removes scrolling again.
- **Reload (`pr-reload`).** With probe PR #1 open, push a commit to its `change` branch from a temporary clone. The window still shows the old head. `node $V click --role button --name "Reload"`, then `node $V wait --text <new short sha>`.
- **Errors (`pr-invalid`, `pr-not-found`).** Type `k-dang/glass-api-probe/pull/1` (no host): the snapshot shows the Open button disabled. Type `https://github.com/k-dang/glass-api-probe/pull/9999` and Open: `wait --text "Pull request not found"`. The `alert` holds the title and detail, beside Back to PRs and Try again.
- **Links (`pr-links`).** Click a `link` in the description; evaluate `location.href` over raw CDP and it is still `glass://app/index.html`.
- **Proof.** Snapshots and screenshots of each state, plus the head SHA before and after Reload.

## Gotchas

- `pr-denied` needs an organization that refuses your token (SAML, IP allow list) and usually can't be produced honestly; the backend tests cover it.
- GitHub answers the same for a private repo you can't see as for one that doesn't exist, so both show "Pull request not found".
- Run steps one after another with pauses in between: earlier versions dropped the backend socket while the window was hidden, and only a sequence spread over time catches that again.
- Clicking an ordinary description link opens the user's browser; image previews stay inside Glass.
- `wait --text` reads `innerText`, which doesn't include the URL field's value; check it in a `snapshot` instead.
