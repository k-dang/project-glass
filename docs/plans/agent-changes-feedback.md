# Feedback on Agent Changes

Design and inline interaction approved. Implementation is split into three local tickets:
collect durable inline Feedback notes, stage/send them, and recover canceled queued feedback.

Review the UI behavior first in the [standalone interactive prototype](../prototypes/agent-feedback.html).
It simulates code, message acceptance, queueing, failure, and Sandbox expiry locally.

The UI follows an inline annotation flow: selecting code or using the gutter opens the editor at
that range, saving places the Feedback note directly under its code, and editing happens there.
Keep the Files sidebar in place after saving; the Feedback tab is an optional overview. Collected
notes still move together into the Agent's composer for sending. This adapts the selection and
inline-comment interaction from [Plannotator](https://github.com/backnotprop/plannotator/tree/main).

## Agreed workflow

- Collect Feedback notes across files and send them together as one message to the same Agent.
- Read the Agent's response in its existing conversation.
- Let the Agent continue working during feedback. Keep the displayed changes stable until the user
  chooses Show latest, and preserve the original code each Feedback note referred to.
- Attach Feedback notes to a line or range on either side of the diff. Use the existing message
  composer for feedback about the overall change.
- Save unsent Feedback notes across restarts. Allow editing and deletion before sending. After a
  successful send, clear the notes from the diff; the conversation keeps the sent feedback.
- After Show latest, keep older Feedback notes with their original code and an older-version label.
  The user may send, edit, or discard them.
- Stage collected Feedback notes in the existing composer so the user can review them and add an
  overall instruction before pressing Send.
- Show staged notes as an attached group, keeping existing unsent text and images. Notes remain
  inspectable, editable, and removable with their original locations/code. Staging again updates
  that group without duplicating it.
- Sending to an idle Agent starts a Turn. Sending while a Turn runs queues the feedback for the
  next Turn, rather than steering the current one.
- Keep notes intact if Glass cannot accept the message. Once accepted into the conversation or
  queue, clear those notes from Changes. If the Agent's Turn later fails, retain the sent feedback
  in the conversation, where the user can retry it.
- Canceling queued feedback returns its notes to unsent feedback, preserving newer notes and the
  current composer's text/images. If the message has already started, explain that cancellation
  was too late and leave the sent feedback in its Turn. The existing cancellation behavior for
  the message's ordinary text/images stays unchanged; recovery here concerns Feedback notes.
- Feedback notes belong to their Agent. Normal Agent removal deletes them with its other local
  records and keeps the existing removal confirmation rules. Sandbox expiry keeps the Agent and
  its locally saved notes until removal.

## Boundaries

- Feedback goes to the same Agent, using its existing conversation. Notes remain private to Glass.
- The feature applies to both Agent programs and to local/Sandbox Agents where selectable Changes
  are available. Preserve locally saved notes when fresh Changes cannot be fetched.
- Line/range feedback requires displayed text. Binary files and changes whose patches cannot be
  displayed keep their existing placeholders; overall feedback uses the message composer.
- Existing Permission request/Question restrictions still govern sending. Blocked sends retain
  the unsent message and its notes.
- Feedback notes have no separate resolution workflow. After sending, the conversation owns the
  feedback and the Agent's response.

## Source constraints

- Both Agent programs and local/Sandbox placements share the Changes and message transports.
- Changes already constructs a Git base/tree pair but returns only changed files. Capturing the
  original selected text locally is necessary; a remote Sandbox and its Git objects can disappear.
- Diff selection and old/new range highlighting exist. The current PR comment action uses a single
  hovered line, so Feedback notes need range-aware selection independently of GitHub Draft stores.
- Message acceptance stores a Turn or Queued message before host delivery. A host failure leaves a
  failed Turn containing the sent message.
- Queue cancellation currently deletes the queued message without restoring its contents. It can
  also succeed as a no-op after that message has already started.
- Permission requests and Questions block ordinary sends. An expired/deleted Sandbox retains its
  Agent/transcript but cannot accept another message.
- Removing an Agent deletes its local records. Existing warnings cover uncommitted changes only.

## Implementation outline

- Extract the diff rendering/selection seam already used by PR annotations; keep Feedback notes
  independent of GitHub Draft/Ask stores.
- Return Changes snapshot identity with the files and capture selected original text from the
  displayed diff. Store notes on this device, independent of the displayed diff component and host.
- Extend the existing unsent message and transcript/queue message representation to carry a
  structured Feedback-note group. Render locations and snippets in the composer and transcript,
  and format that context for either Agent program.
- Make message acceptance and consuming its pending notes one durable operation. Preserve note
  identity through queueing so actual cancellation can restore the accepted note set without
  overwriting newer work or restoring a message that has already started.
- Include Feedback notes in normal Agent cleanup. Keep notes locally with their retained Agent
  when its Sandbox expires.

## Acceptance checks

- A line/range on either diff side creates a note with the correct original text and location.
- Navigation/restart retains unsent notes and staged feedback alongside existing text/images.
- Working or externally edited files do not change an open diff or a note's saved code. Show latest
  preserves older notes and identifies them as belonging to an older version.
- Staging again updates one group, and editing/removing a note is reflected wherever it appears.
- Sending starts or queues exactly one message to the same Agent and consumes only its included
  notes. Failed/blocked acceptance preserves the unsent work; later Turn failure retains sent work.
- Queue cancellation restores its notes alongside newer work. A cancellation racing Turn start
  reports the actual outcome and cannot duplicate the sent feedback as restored notes.
- Locally saved notes remain readable while their Agent is retained, including after Sandbox
  expiry. Normal Agent removal deletes them with the Agent's other records.
- Validate contracts, persistence/queue behavior, and renderer interactions with focused tests;
  verify the completed flow in an isolated Glass instance. Update required Agent-program recordings
  if their inputs change, following the repository's existing recording workflow.
