# 02: Stage and send feedback to the same Agent

**What to build:** The user collects Feedback notes into one attachment group in the existing
Agent composer, adds an overall instruction if useful, and sends one message to that same Agent.
An idle Agent starts a Turn; a busy Agent receives a Queued message for its next Turn. The
conversation keeps the sent feedback and the Agent's response.

**Design:** [Feedback on Agent Changes](../agent-changes-feedback.md).

**Blocked by:** 01: Collect durable inline Feedback notes.

**Status:** done

- [x] Review feedback stages the collected notes in the existing composer without replacing
      unsent text or images. Staging again updates one group without duplicating notes. The staged
      group and other unsent message content survive navigation and relaunch.
- [x] Each staged note exposes its location and original code for inspection. Editing or removing
      it updates the same underlying note wherever shown; older notes keep their original context.
      The user saves or cancels an open note before staging the collection.
- [x] A message containing Feedback notes can be sent without additional message text. The Agent
      receives the overall instruction, each note, and its original code/location as one message.
- [x] Sending to an idle Agent starts a Turn; sending while it works queues the message for the
      next Turn. Feedback uses ordinary message delivery rather than Steer, and remains private to
      the same Agent. Both Agent programs and local/Sandbox placements use the existing host seam.
- [x] Acceptance durably stores the message and consumes only its included pending notes in one
      operation. Duplicate submission or retry cannot create a second accepted feedback message or
      remove newer notes and unsent work.
- [x] A queued or sent message retains immutable structured Feedback-note content and identity,
      sufficient for inspection in the conversation and later cancellation recovery. Existing
      persisted messages without Feedback notes remain readable.
- [x] Loading exposes progress and prevents duplicate sending. Rejected or blocked acceptance
      preserves the unsent text, images, and notes. Permission requests, Questions, and unavailable
      Agents retain their existing sending restrictions with a visible explanation.
- [x] Accepted notes leave Agent Changes and remain readable with their code in the conversation
      or queue. Later delivery or Turn failure keeps the accepted message in the conversation, where
      the user can reuse its feedback; it does not silently recreate unsent notes.
- [x] Focused tests cover composer preservation, synchronized note edits, notes-only messages,
      acceptance/retry, running-Agent queueing, and failures. Update required real Agent-program
      recordings when inputs change, using the repository's established recording workflow.
- [x] Run affected repository checks and demonstrate the complete annotation-to-response path,
      including queueing and rejected acceptance, in an isolated Glass instance.

## Comments

- Staged notes are a `staged` flag on each saved note; `SendMessage` names the staged note ids, and the backend takes them in the same transaction that stores the Turn or Queued message, refusing a send whose notes were already taken.
- Rejected acceptance is covered by a renderer test; the isolated-instance run showed staging, sending to an idle Agent, and queueing while a Turn ran.
- Left for later: a staged note doesn't show its Older version label in the composer (it keeps its original code), and a failed Turn's feedback is readable in the conversation but has no one-click resend.
