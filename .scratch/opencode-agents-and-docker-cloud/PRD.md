Status: in-progress

# OpenCode Agents and Docker Cloud Sandboxes

## Problem Statement

Kevin wants to work with an OpenCode Agent in Glass, including in Docker Cloud Sandboxes, with
access to an inexpensive model. Docker already supplies a native OpenCode environment, but Glass
only knows how to run Claude Code and pi. Changing the Sandbox image alone cannot produce a
working Glass Agent: Glass must understand OpenCode's conversation, streaming output, tool calls,
Steers, requests, and Turn endings.

The earlier Docker Plugin draft provisioned Claude Code and required an Anthropic API login. Kevin
asked to delete that example before implementation. The new provider must implement his chosen
Agent program and the verified option of using an OpenCode model without a model API key. Kevin
also needs reliable cleanup and clear installation and verification
instructions, so trying the feature does not leave unexpected cloud machines running.

## Solution

Add OpenCode as an Agent program for ordinary Agents on this device and in a Sandbox. The user
starts and works with these Agents through Glass's existing creation, messaging, transcript,
Changes, request, and removal flows.

Build the Docker Cloud Sandboxes Plugin using Docker's native OpenCode environment. Its initial
model is the verified `opencode/big-pickle`, which worked with an empty cloud secret store and was
listed with zero input/output token cost. Docker compute is still billed independently. The user
can start with a public repository without supplying an Anthropic key; private repository access
and pushes use an appropriately scoped Docker-managed GitHub credential.

Use OpenCode's native V1 API inside Glass's existing agent host. Preserve the same native
conversation across Turns, reconnects, and supported restarts. The user should see a truthful
success, failure, stop, request, or unreachable state rather than a conversation that silently
changes identity, duplicates output, or remains busy forever.

## User Stories

1. As a Glass user, I want to choose OpenCode when starting an Agent on this device, so that I can
   use my installed and configured OpenCode program from Glass.
2. As a Glass user, I want to choose Docker Cloud Sandboxes when starting an OpenCode Agent, so
   that its work runs on an isolated remote machine.
3. As a Glass user, I want Docker Sandbox creation to work without a local OpenCode installation,
   so that Docker's native environment supplies the remote Agent program.
4. As a Glass user, I want a local OpenCode Agent to get its own worktree and branch from my Local
   checkout, so that its changes fit the existing local Agent workflow.
5. As a Glass user, I want a Sandbox Agent to clone the repository from my selected base branch
   onto the Agent's branch, so that it starts in the right place and Changes has the correct base.
6. As a Glass user, I want creation progress to identify the current setup step, so that I can
   distinguish machine provisioning, repository setup, and Agent startup.
7. As a cost-conscious Glass user, I want an initial Docker model that works without a paid model
   API key, so that I can try the complete workflow with a low barrier to entry.
8. As a Glass user, I want the displayed default model to match the model the Agent actually runs,
   so that leaving Model at Default produces a predictable result.
9. As a local OpenCode user, I want the model picker to reflect my native OpenCode configuration,
   so that I can select the models available to my installation.
10. As a Glass user, I want to choose the Efforts a model actually offers and restore its default,
    so that a previous choice does not silently carry into a later Turn.
11. As a Glass user, I want model discovery before Sandbox creation to avoid allocating a machine,
    so that browsing the picker does not incur compute charges.
12. As a Glass user, I want to send a message and see the response stream into its Turn, so that I
    can follow the Agent's work as it happens.
13. As a Glass user, I want reasoning and tool activity shown when OpenCode provides them, so that
    I can understand what the Agent is doing.
14. As a Glass user, I want completed and failed tool calls to show their actual outcome, so that
    the transcript does not leave finished work marked as running.
15. As a Glass user, I want later messages to continue the same OpenCode conversation, so that I
    do not have to repeat the context from earlier Turns.
16. As a Glass user, I want two Agents working on the same repository to retain separate
    conversations, so that their context and requests cannot be mixed up.
17. As a Glass user, I want to queue a message while a Turn runs, so that it starts through the
    existing Queued message workflow when the Agent is ready.
18. As a Glass user, I want to Steer a running Turn, so that new instructions can affect the work
    before it finishes.
19. As a Glass user, I want Stop to end active work and preserve messages the Agent did not take
    in, so that an undelivered Steer is not lost or executed during an unrelated later Turn.
20. As a Glass user, I want to send a fresh message after Stop, so that stopping work does not
    leave the conversation unusable.
21. As a Glass user, I want each Turn to end once with the correct outcome, so that a late event
    from a stopped or previous Turn cannot finish the next one.
22. As a local OpenCode user, I want native Permission requests to be answerable in Glass, so that
    I can allow or deny an action without leaving the conversation.
23. As a Glass user, I want to answer OpenCode's structured Questions in Glass, so that the Agent
    can continue with my selected option or supported free-text answer.
24. As a Glass user, I want requests to stop waiting when a Turn ends or its program exits, so
    that Glass never presents a request that OpenCode can no longer receive an answer to.
25. As a Glass user, I want supported images, Mentions, and Feedback notes to reach OpenCode with
    the message, so that I can use the existing Agent composer for more than plain text.
26. As a Glass user, I want the Agent's native Commands to be discoverable and executable, so that
    commands work in the repository context the Agent actually uses.
27. As a Glass user, I want selected Skill packs and opted-in Local skills available to a Sandbox
    Agent, so that the Agent receives exactly the skills I chose at creation.
28. As a Glass user, I want Changes and file discovery to work for an OpenCode Agent, so that I
    can inspect its work through the same Glass surfaces as other Agents.
29. As a Glass user, I want a Sandbox Turn to keep running while Glass is closed, so that closing
    my desktop does not cancel remote work.
30. As a Glass user, I want to reconnect to an existing Agent without duplicate transcript output,
    so that I can continue reading from the place Glass last saved.
31. As a Glass user, I want a recoverable native server restart to retain the correct conversation,
    so that a new process does not imply a new Agent history.
32. As a Glass user, I want a missing or deleted native conversation to produce an actionable
    failure, so that Glass never silently substitutes a fresh conversation.
33. As a Glass user, I want clear guidance for a missing executable, unsupported OpenCode version,
    absent login, rejected model, or lost connection, so that I know what must change before retrying.
34. As a Docker Sandbox user, I want private repository and push access to use Docker-managed
    credentials, so that the Plugin does not copy unrelated local login files into the machine.
35. As a Docker Sandbox user, I want cancelling or failing creation to clean up a partially
    provisioned machine, so that unsuccessful setup does not leave billable infrastructure behind.
36. As a Docker Sandbox user, I want removing an Agent to remove its machine even if the host is
    unreachable, so that cleanup does not depend on a healthy Agent process.
37. As a Docker Sandbox user, I want expiration and an already-deleted machine to be handled
    explicitly, so that I understand why an Agent can no longer take messages.
38. As a Docker Sandbox user, I want the Plugin to state the machine size, lifetime, and deletion
    behavior, so that I understand the compute commitment and when unpushed files disappear.
39. As a Glass user, I want straightforward Plugin installation and a create/message/remove check,
    so that I can verify both the Agent and machine cleanup myself.
40. As an existing Glass user, I want saved Claude Code and pi Agents to keep working, so that
    adding OpenCode does not change my existing conversations or settings.

## Implementation Decisions

- **Scope and terminology:** add OpenCode to ordinary Agents locally and in Sandboxes. Update
  shared Agent program identities, capabilities, labels, icons, documentation, and glossary
  definitions where their current wording assumes two programs.
- **Adapter boundary:** implement OpenCode behind the existing Agent adapter and Agent session
  interfaces. Reuse the host's configuration, message delivery, event reporting, request answering,
  and scoped shutdown responsibilities. Extend those interfaces only for a concrete requirement
  that cannot be represented correctly today.
- **Native protocol:** use the V1 native server API. Pin the legacy OpenCode SDK to the verified
  1.15.13 release. Its v2 client entry point is the client for OpenCode 1, not the OpenCode 2 CLI.
  CLI 1.19.5 is the tested compatibility baseline. Detect the supported generation and validate
  health response JSON; an HTML response with status 200 is not a successful version probe.
- **Existing host architecture:** the agent host owns the OpenCode process and translates native
  events into the existing Glass transcript and journal. The backend remains the transcript of
  record. Local and Sandbox Agents use this same implementation, following the agent-host ADR.
- **Process ownership:** scope each live OpenCode server to the lifetime that owns its Agent
  sessions. Keep its HTTP interface private to the machine, authenticate it with a generated
  process credential, drain output pipes, and clean up processes on startup failure and scope
  closure. Establish readiness before admitting work. Begin with the ownership needed by the
  current host; add no general process pool or external-server configuration feature.
- **Executable configuration:** support the installed local OpenCode executable through the same
  command-configuration pattern as existing Agent programs. Missing or unsupported installations
  fail with useful guidance. Docker supplies its own native OpenCode executable.
- **Conversation identity:** persist a durable association between the Glass Agent and its native
  OpenCode session. Restore it before sending another message, including after a host restart.
  Conversation identity belongs to the Agent/program integration, not to Docker's opaque Sandbox
  state. A failed lookup must not silently create a replacement conversation. Use the smallest
  durable representation that satisfies this requirement; any necessary migration must preserve
  existing Agents and need no manual database editing.
- **Streaming and Turn boundaries:** consume the native event stream before creating sessions or
  submitting prompts. Correlate native user messages, assistant messages, tool calls, and endings
  with the active Glass Turn. Emit one ending per Turn, complete or expire its open parts, and
  ignore stale terminal events that belong to earlier work.
- **Steer and Stop:** submit native V1 prompts in scoped background work, retaining the synchronous
  request's completion as a cancellation fence. The async endpoint's 204 is not admission. Distinguish
  admission from consumption, preserve message identity, and return unconsumed Steers through
  Glass's existing behavior. Stop must interrupt active work, settle pending requests, and prevent
  undelivered input from leaking into the next Turn. Interpret the native cancellation outcome:
  a stored tool status of completed is insufficient evidence that the Turn succeeded.
- **Reconnect and failure:** keep the existing backend-to-host journal replay. Separately handle
  host-to-OpenCode stream loss with bounded recovery and reconciliation of the affected native
  session and message history. Recovered output must not duplicate transcript parts. An unknown
  outcome remains an explicit failure or interruption rather than an invented success.
- **Permissions and Questions:** translate native Permission requests and supported structured
  Questions into the existing Glass request types and send answers back under their native IDs.
  Offer only permission behavior OpenCode enforces natively. The existing Claude-specific
  Permission mode choices must not be relabeled as OpenCode modes. Sandbox Agents retain the
  existing bypass policy; Questions remain interactive. Unsupported request forms must receive a
  clear supported decline or failure rather than leaving the Agent waiting indefinitely.
- **Models and Efforts:** map native model/provider identities and variants into Glass's current
  model and Effort types. Preserve native identifiers and implement reset-to-default correctly
  after a named selection or a resumed conversation. A catalog's connected-provider label is not
  proof that a model's authentication will succeed.
- **Pre-creation Docker catalog:** the provider must answer model discovery without creating a
  machine or requiring OpenCode on this device. Initially advertise the verified Big Pickle model
  and configure the remote OpenCode default to match it. Expose additional Docker model choices
  only with a compatible catalog and credential setup that the provider can substantiate. Do not
  copy the whole local provider inventory into the Docker picker or silently choose a paid fallback
  if the bootstrap model is unavailable.
- **Composer, Commands, and skills:** deliver message images, resolved Mention context, and
  Feedback notes through native supported inputs. Discover and execute native Commands in the
  Agent's repository context. Make chosen Skill packs and opted-in Local skills readable through
  OpenCode's supported skill configuration, preserving the existing per-Agent selection semantics.
- **Independent runner support:** keep Tour engines and Agent review engines restricted to their
  existing implementations. Their settings currently share Agent program types; separate the
  supported selections where necessary so adding OpenCode to Agents does not expose an
  unimplemented runner. The Global conversation continues to use pi.
- **Docker Plugin:** build a fresh in-repository provider for the native OpenCode environment and
  offer OpenCode as its initial Agent program. The earlier Claude-based example is deleted.
  Keep Docker-specific commands, network policy,
  credentials, image choices, and machine state entirely inside the Plugin.
- **Plugin distribution:** keep the Plugin self-contained in this repository for now, copy the
  current unpublished Glass Plugin contract into its folder, and import its types locally. It must
  remain installable by copying the folder into Glass's plugins folder and restarting Glass.
  Preserve the existing Promise and AbortSignal contract. The deleted, unreleased draft requires
  no legacy-state migration or compatibility shim.
- **Provisioning:** use the native OpenCode environment on Linux amd64 with the verified small
  machine configuration of one CPU and 2 GiB. Clone the selected base branch, create the Agent's
  branch, preserve the origin base ref, transfer Glass's host bundle, and start it independently
  of the provisioning command. Install Node 24 privately for Glass because the tested image has
  Node 22. Publish only the authenticated Glass host interface required by the provider; the
  investigative OpenCode port exposure is not the product connection design.
- **Credentials:** keep model credentials in Docker's cloud secret store and local OpenCode
  credentials in its native local configuration. The initial free-model path must not require an
  Anthropic key or another model key. Allow anonymous public clones; use a repository-scoped
  Docker-managed GitHub token for private clones and pushes. Surface missing-login guidance when
  access needs it, without copying Glass's own GitHub identity or local credential files into the
  Sandbox. Account metadata alone must not be treated as proof of working authentication.
- **Sandbox lifecycle:** record a unique cleanup handle before a create request can leave a
  machine whose response was lost. Respect cancellation during setup. Resolve connection targets
  afresh, distinguish gone machines from transient failures, and make removal work when already
  gone. Keep the existing explicit expiry/deletion behavior visible and within Docker's lifetime
  cap. This feature does not introduce idle detection, automatic pause, or a new renewal policy.
- **Errors and logging:** use the existing tagged expected failures and user-safe host/provider
  error boundaries. Keep service behavior independent of transport handlers. Follow the existing
  wide-event rules; credentials, authorization headers, prompts, message bodies, and transcripts
  must not become diagnostic fields or command arguments.
- **Documentation:** explain Docker login, optional model-provider credentials, GitHub access,
  installation, the default model, machine resources, expiry, compute billing, and how to inspect
  or remove the exact machine associated with an Agent. Make the complete Glass verification
  flow reproducible from those instructions.

## Testing Decisions

- The confirmed main automated boundary is the existing Agent adapter/session interface, exercised
  with recordings of real OpenCode traffic. This is the same high boundary already used for the
  Claude Code and pi session tests. Kevin confirmed this boundary together with one end-to-end
  Glass-to-Docker create/message/reconnect/remove check.
- Good tests assert what an Agent reports and does: transcript parts, request outcomes, preserved
  conversation context, Stop and Steer behavior, and observable cleanup. Avoid tests coupled to
  private maps, exact helper decomposition, incidental process allocation, or a second hand-built
  model of the OpenCode protocol.
- Extend the established real-program recording and replay harness to capture the native OpenCode
  SDK's HTTP requests, responses, event stream, and required process lifecycle. Record the SDK pin
  and actual CLI version. A changed pin or outbound interaction must require intentional recording
  updates, as specified by the recording ADR.
- Cover a streamed response, thinking when provided, a tool round trip, multiple Turns, and two
  distinct conversations. Assert correct native session reuse and separation through observable
  history and replies.
- Cover active steering, Stop during a tool, immediate Stop during prompt admission, an undelivered
  Steer, a failed or delayed cancellation, a fresh Turn after Stop, and late terminal events from
  previous Turns. Each Turn must end once, and no held input may unexpectedly run afterward.
- Cover native permission allow and deny, a Question answered by choice and supported free text,
  cancellation while waiting for a request, and an answer arriving after a request expired. These
  are required implementation checks; the investigative Docker probe did not establish them.
- Cover image delivery, resolved message context and Feedback notes, native Command discovery and
  execution, selected Skill packs, and opted-in Local skills. Exercise the actual supported native
  inputs and configuration rather than asserting only the constructed request object.
- Cover model and Effort selection, restoring program defaults, unsupported choices, and rejected
  authentication. Ensure Docker's advertised default is the one its Agent runs. Confirm that
  pre-creation catalog reads do not allocate cloud infrastructure.
- Cover client reconnect, server restart between Turns, stream loss while a Turn finishes,
  bounded unsuccessful recovery, and a missing native conversation. Verify preserved identity,
  correct outcome classification, and no duplicate transcript output. The remaining stream-loss
  race must not be treated as already proven by the successful between-Turn restart experiment.
- Use the current Sandbox-provider and Agents/backend tests for behavior owned above the adapter:
  creation state recording, cancellation cleanup, transient failure versus gone, removal when
  unreachable or already gone, and unchanged settings for existing Claude Code and pi Agents.
  Add narrow pure-logic or process tests only for meaningful failures that real recordings cannot
  reproduce on demand. Keep these within existing test seams rather than building another test
  framework for this feature.
- Use the existing desktop test setup for program selection, truthful permission controls, model
  display, and the separation between ordinary Agents and the existing runner settings. Use one
  final isolated Glass-to-Docker journey as the user-facing acceptance check, rather than making
  every unit test depend on a cloud account.
- Acceptance journey: install the Plugin, start an OpenCode Agent in Docker Cloud Sandboxes on a
  public repository, send a message and observe a completed response, execute a small tool action,
  close and reopen Glass during remote work, and confirm the same Agent reconnects. Remove the
  Agent and inspect Docker until the exact machine is confirmed gone. Also exercise a local
  OpenCode Agent in a disposable worktree.
- Wait on events and the existing eventually/waitFor helpers. Do not order tests with sleeps,
  elapsed-time assertions, or test-clock-incompatible repetition. Keep product deadlines far above
  the test timeout in success-path tests.
- Complete the focused adapter, provider, backend, and UI checks, the repository formatting/lint/
  type checks, and the server/host build. Broaden testing when affected contracts or failures justify
  it. Required live checks must name their temporary resources before allocation and clean them up;
  they must never use production databases or unrelated cloud machines.

## Out of Scope

- OpenCode as a Tour engine, Agent review engine, Agent review Follow-up program, or Global
  conversation program.
- OpenCode 2 integration, automatic major-version upgrades, support for every historical OpenCode
  release, or a simultaneous V1/V2 compatibility framework.
- ACP integration, an extensible Agent-program Plugin API, T3's provider-instance framework, shared
  server pooling, and a user-configurable external OpenCode server.
- Adding pi to Docker, supporting other Sandbox platforms, or expanding the Docker Plugin into a
  generic cloud-development environment manager.
- A new login UI, copying local subscriptions into cloud machines, new model-provider billing
  integrations, or promising that a currently free model stays free or available indefinitely.
- Automatic idle detection, pausing, resizing, cost dashboards, and a new expiry-extension policy.
- Migrating live data, touching production infrastructure, publishing a package, or moving the
  Plugin to another repository as part of this implementation.

## Further Notes

The implementation follows the existing Agent adapter/session and Sandbox provider boundaries.
Native startup and failure-finalization races found by the real-program checks are covered by the
recordings. The completed implementation and live acceptance evidence are recorded in the
[verification report](../../docs/research/opencode-implementation-verification.md).

The new Docker provider requests a 24-hour lifetime with automatic deletion, so it can continue
incurring compute charges while Glass is closed. The smaller verified machine and the free-model
bootstrap address the immediate cost goal; a shorter renewable lifetime was discussed as a future
option, not approved as a lifecycle redesign in this feature.

The original source audit and Docker probe established the protocol and platform choices. The
old provider example was deleted before the fresh OpenCode implementation. All temporary cloud
machines and isolated app instances used for implementation verification have been cleaned up.

Evidence and governing decisions:

- [Live Docker/OpenCode verification](../../docs/research/docker-opencode-verification.md).
- [Sanitized verification results](../../docs/research/evidence/docker-opencode-verification.json).
- [Agent host ADR](../../docs/adr/0007-agents-run-in-an-agent-host.md).
- [Sandbox provider ADR](../../docs/adr/0010-sandboxes-come-from-provider-plugins.md).
- [Real-program recordings ADR](../../docs/adr/0011-tests-replay-recordings-of-real-agent-programs.md).
- [Backend logging ADR](../../docs/adr/0012-the-backend-log-is-one-line-per-unit-of-work.md).

The first implementation is complete when the in-scope user stories pass through the supported
Glass flows, focused real-program recordings cover the lifecycle and request boundaries, the
required checks pass, and the documented final Docker acceptance journey confirms removal of its
machine. If a native capability cannot meet a required story, record the concrete blocker and
revisit that requirement explicitly rather than silently omitting it or shipping a stub.

## Comments

- Kevin requested deletion of the existing Docker Cloud example before starting implementation.
  Its five source, test, contract, launcher, and README files were removed; the replacement is a
  fresh OpenCode provider, with no compatibility requirement for the unreleased draft.

- 2026-11-10: Kevin confirmed the existing Agent adapter/session boundary with real OpenCode
  recordings, plus one end-to-end Glass-to-Docker create/message/reconnect/remove check.

- 2026-11-11: Native recordings and isolated Glass checks cover ordinary local OpenCode Agents,
  Docker creation, messages and tools, Changes, reconnecting after closing Glass, conversation
  continuity, and confirmed machine deletion. The removal check includes the dirty-Sandbox
  confirmation. Private-repository credentials and pushes were not part of the live acceptance run.

- 2026-11-11: Final validation passed: 796 workspace tests (2 skipped), 3 Docker provider tests,
  formatting, lint, type checks, and the server/host/desktop build.

- 2026-11-11: An independent Claude Opus 5.5 review invalidated the earlier completion assessment.
  Native reproductions exposed dropped subagent requests, blocking Commands, pre-assistant failures,
  and cancellation admission races. The implementation and real-program coverage were revised;
  see the verification report for the final validation and remaining limits.

- 2026-11-11: The second review's five reproduced failures are corrected and covered by native
  recordings: compaction/subtask continuation, queued sends during restart, opaque pagination,
  unreachable discard cleanup, and event processing cost. Twenty native scenarios, 810 workspace
  tests (2 skipped), 3 provider tests, formatting/lint/types, and build pass. Long Command
  preparation and a Steer at native run exit remain unverified. Kevin stopped the additional
  investigation on 2026-11-12; the review loop is closed without another review round.

- 2026-11-12: Kevin requested a bounded simplification. Process lifecycle now belongs to the
  existing runtime module, active-Turn and delivery facts have one adapter owner, and the Turn
  mapper receives delivery status instead of tracking it again. Related regression cases are
  consolidated into 12 real-program workflows, and the eight superseded recordings are removed.
  Feature scope is unchanged; the stopped timing investigation remains closed.
  Validation passed: all 12 real-program workflows, their replay and two Turn tests, 802 workspace
  tests (2 skipped), 3 provider tests, formatting/lint/types, and build.
