# 02: Stage and send feedback to the same Agent

**What to build:** The user collects Feedback notes into one attachment group in the existing
Agent composer, adds an overall instruction if useful, and sends one message to that same Agent.
An idle Agent starts a Turn; a busy Agent receives a Queued message for its next Turn. The
conversation keeps the sent feedback and the Agent's response.

**Blocked by:** 01: Collect durable inline Feedback notes.

**Status:** ready-for-agent

- [ ] Review feedback stages the collected notes in the existing composer without replacing
  unsent text or images. Staging again updates one group without duplicating notes. The staged
  group and other unsent message content survive navigation and relaunch.
- [ ] Each staged note exposes its location and original code for inspection. Editing or removing
  it updates the same underlying note wherever shown; older notes keep their original context.
  The user saves or cancels an open note before staging the collection.
- [ ] A message containing Feedback notes can be sent without additional message text. The Agent
  receives the overall instruction, each note, and its original code/location as one message.
- [ ] Sending to an idle Agent starts a Turn; sending while it works queues the message for the
  next Turn. Feedback uses ordinary message delivery rather than Steer, and remains private to
  the same Agent. Both Agent programs and local/Sandbox placements use the existing host seam.
- [ ] Acceptance durably stores the message and consumes only its included pending notes in one
  operation. Duplicate submission or retry cannot create a second accepted feedback message or
  remove newer notes and unsent work.
- [ ] A queued or sent message retains immutable structured Feedback-note content and identity,
  sufficient for inspection in the conversation and later cancellation recovery. Existing
  persisted messages without Feedback notes remain readable.
- [ ] Loading exposes progress and prevents duplicate sending. Rejected or blocked acceptance
  preserves the unsent text, images, and notes. Permission requests, Questions, and unavailable
  Agents retain their existing sending restrictions with a visible explanation.
- [ ] Accepted notes leave Agent Changes and remain readable with their code in the conversation
  or queue. Later delivery or Turn failure keeps the accepted message in the conversation, where
  the user can reuse its feedback; it does not silently recreate unsent notes.
- [ ] Focused tests cover composer preservation, synchronized note edits, notes-only messages,
  acceptance/retry, running-Agent queueing, and failures. Update required real Agent-program
  recordings when inputs change, using the repository's established recording workflow.
- [ ] Run affected repository checks and demonstrate the complete annotation-to-response path,
  including queueing and rejected acceptance, in an isolated Glass instance.
