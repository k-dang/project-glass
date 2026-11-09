# 03: Recover canceled queued feedback

**What to build:** Canceling a Queued message containing feedback returns its Feedback notes to
unsent feedback so the user can edit or resend them. Cancellation preserves newer work and tells
the user when the message has already started instead of pretending it was withdrawn.

**Design:** [Feedback on Agent Changes](../agent-changes-feedback.md).

**Blocked by:** 02: Stage and send feedback to the same Agent.

**Status:** ready-for-agent

- [ ] Successful cancellation removes the Queued message and durably restores its Feedback notes
      with their original text, locations, code, and older-version identity.
- [ ] Restored notes appear through the existing inline/older-feedback surfaces and can be staged
      again. They coexist with newer notes without duplicating restored identities or overwriting
      newer edits.
- [ ] Cancellation leaves the current composer's newer text, images, and staged feedback intact.
      Recovery applies to Feedback notes; the canceled message's ordinary text/images keep existing
      cancellation behavior.
- [ ] The cancellation outcome reflects whether the message was actually removed. If it has
      already become a Turn, preserve its sent feedback, restore no notes, and explain that it was
      too late to cancel.
- [ ] Repeated cancellation and restart cannot restore the same notes twice or lose the accepted
      feedback between queue removal and note restoration. A cancellation failure leaves the queued
      feedback available and reports the failure.
- [ ] Focused tests deterministically exercise successful cancellation alongside newer notes and
      composer content, repeated cancellation, persistence, failure, and cancellation racing Turn
      start. Synchronize on events as required by the repository's testing policy.
- [ ] Run affected repository checks and demonstrate queueing, restoring, editing, and resending
      feedback, plus the too-late outcome, in an isolated Glass instance.
