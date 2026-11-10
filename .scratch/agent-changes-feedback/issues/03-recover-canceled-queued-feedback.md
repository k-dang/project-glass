# 03: Recover canceled queued feedback

**What to build:** Canceling a Queued message containing feedback returns its Feedback notes to
unsent feedback so the user can edit or resend them. Cancellation preserves newer work and tells
the user when the message has already started instead of pretending it was withdrawn.

**Design:** [Feedback on Agent Changes](../agent-changes-feedback.md).

**Blocked by:** 02: Stage and send feedback to the same Agent.

**Status:** done

- [x] Successful cancellation removes the Queued message and durably restores its Feedback notes
      with their original text, locations, code, and older-version identity.
- [x] Restored notes appear through the existing inline/older-feedback surfaces and can be staged
      again. They coexist with newer notes without duplicating restored identities or overwriting
      newer edits.
- [x] Cancellation leaves the current composer's newer text, images, and staged feedback intact.
      Recovery applies to Feedback notes; the canceled message's ordinary text/images keep existing
      cancellation behavior.
- [x] The cancellation outcome reflects whether the message was actually removed. If it has
      already become a Turn, preserve its sent feedback, restore no notes, and explain that it was
      too late to cancel.
- [x] Repeated cancellation and restart cannot restore the same notes twice or lose the accepted
      feedback between queue removal and note restoration. A cancellation failure leaves the queued
      feedback available and reports the failure.
- [x] Focused tests deterministically exercise successful cancellation alongside newer notes and
      composer content, repeated cancellation, persistence, failure, and cancellation racing Turn
      start. Synchronize on events as required by the repository's testing policy.
- [x] Run affected repository checks and demonstrate queueing, restoring, editing, and resending
      feedback, plus the too-late outcome, in an isolated Glass instance.

## Comments

- Cancel deletes the Queued message and puts its notes back, unstaged, in one transaction; a note id that already exists is left alone. A Turn started from the queue keeps the Queued message's id, so a cancel that finds no Queued message fails with `QueuedMessageStarted` ("Too late to cancel") when that Turn exists, and succeeds as a no-op otherwise.
- The isolated-instance run showed queueing, canceling with composer text kept, the note back in Changes, editing, restaging, and resending. The too-late outcome can't be forced through the UI (the Cancel button leaves once the message starts), so server and renderer tests cover it.
