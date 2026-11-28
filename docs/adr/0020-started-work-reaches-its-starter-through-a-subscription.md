# Started work reaches its starter through a Subscription

The Global chat and Threads heard about the work they started through a stream of their own. Glass
read each started Thread's last Turn end and each Agent review's state, compared it with a time
saved on the started record, and saved which Turn had told it: a second way to deliver news beside
the Event log (ADR 0019). Now Glass is a Source too. When work the Global chat or a Thread started
finishes, fails, or waits on the user, the `glass` Source reports an Event about it, and the
starter hears it through a Subscription Glass makes when the work starts. A Started work update is
an Update like any other, and it moves the same cursor.

The `glass` Source has two subjects: a Thread and the Agent review of a PR. A Thread reports
`ThreadFinished`, `ThreadFailed` with the reason, and `ThreadWaiting` when its agent asks a
Question or a Permission request. A Turn the user stopped reports nothing. An Agent review reports
`AgentReviewFinished` once the review is written and `AgentReviewFailed` with the reason, and both
end its Subscription: reviewing again is new work and gets a Subscription of its own. A started
Thread's Subscription lasts as long as the Thread, so its starter also hears about the Turns after
the first, as it did before. Each Event names the Turn or review it is about, and the log records
it once, so reading the same Turn end again after a restart adds nothing. Like GitHub, the Source
reports only on subjects a Subscription covers. The Subscription asks for every kind, and its note
is the user's message that asked for the work.

A Subscription belongs to its subscriber, a Thread or the Global chat, and Glass tells both the
same way: it waits until the subscriber is idle and starts the Update as its next Turn, which for
the Global chat is a Turn of the current Session. The Global chat's Subscriptions belong to it, not
to a Session, so they last across Start fresh, as the work it started does. The Global chat can
also subscribe to a PR itself, with the tools a Thread's agent uses. An Outside agent has no Turns
to tell, so the work it starts gets no Subscription.

An Update to the Global chat retries its delivery after a restart, as a Started work update did.
The Global chat's pi can't outlive the backend (ADR 0016), so a restart would otherwise cut off an
Update whose cursor had already moved and lose its Events. Giving up after three Updates in a row
counts per Subscription for the Global chat too, and the user's next message in the current Session
lets it try again. That stops the Global chat and a Thread it started from waking each other with
nobody there, while a Global chat that started five Threads still hears from each, since each has
its own Subscription.

Glass still marks a started Thread's Turn seen, and an Agent review included, once an Update that
told it finished or failed ends without failing, so the Inbox doesn't list what the starter was
already told. Glass reads which work an Update told from the ended Update itself. Telling that a
Thread waits marks nothing, and a failed Update leaves the work unseen, which is how its news still
reaches the user.

## Considered options

- **Keep the Started work stream**: what Glass had. Two ways to deliver news, each with its own
  bookkeeping and its own model check, and news about a PR and about a started Thread reach the
  same Thread as two Turns.
- **A kind of subscriber behind a recipient interface**: there are only two subscribers, and
  telling either one means waiting until it is idle. An Outside agent has no Turns. An id and one
  lookup cover both.
- **Subscriptions that belong to a Session**: Start fresh would forget the work the Global chat
  started, which stays with it across Sessions.
- **Ending a started Thread's Subscription at its first outcome**: the starter would miss the
  Turns after it, such as the one it starts by messaging the Thread to carry on.
- **Subscriptions as the record of started work**: ending a Subscription, or an Agent review's
  final Event, would forget who started the work, which the starter lists with
  `list_started_work`.
- **To-dos completing on merge through the log**: the GitHub Source reports only on PRs a
  Subscription covers, and a merge Event names a PR, not the Thread whose To-dos it completes. It
  would take a wider Source and a cursor of its own to do what reading the Thread's PR already
  does. Completing a To-do starts no Turn and changes nothing the second time, so the log adds
  nothing to it, and it stays as it is.

## Consequences

- `StartedWorkUpdates.ts` and the parts of `StartedWork.ts` that find, record, and reconcile
  outcomes go, with the `started_work_update_outcome_at` and `started_work_update_turn_id` columns
  of `started_thread` and `started_agent_review`, the `StartedWorkUpdate` Turn context, and its
  `glass_started_work_update` prompt block. `started_thread` and `started_agent_review` stay as the
  record of who started what.
- `subscription.thread_id` becomes `subscriber`. When Glass removes a Thread, it also ends the
  Subscriptions about that Thread, as it already ends the ones the Thread holds.
- The `verify-started-work-updates` skill goes. Its `ReportedOnce` is `ToldOnce` in
  `verify-update-delivery`, whose model grows to cover a subscriber whose Update retries delivery
  across the restart, and the seen mark's two rules: telling that a Thread waits marks nothing, and
  finished work reaches the starter, the user, or an unseen mark.
- The pi adapter's check that a retried Turn reached pi before the restart (`piRedelivery.ts`)
  covers every Turn that retries delivery, rather than only a Started work update. `verify-turn-lifecycle`'s coverage of the Global chat's retried Turn moves to
  `Updates.ts`.
- One Update can carry a started Thread's news beside a PR's. The Update prompt words started work
  as well as PRs, and the PR rules, written for a Thread changing its own PR, need wording the
  Global chat can follow, since it changes no code. What Glass sends both Agent harnesses changes,
  so the session recordings for Claude Code and pi need recording again.
- A migration rewrites the Started work update Turns already in the database as Updates.
- News of started work that waits unread for 30 days goes with the log's other Events. Before,
  it waited forever.
