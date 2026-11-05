Status: ready-for-agent

# Global conversation and MCP tool bridge

## Problem Statement

Glass has PR lists, a Queue, To-dos, an Activity log, Agent reviews, and Agents, but the user must move between these areas and operate each one separately. An Agent works in one repository or review checkout and has no general interface to Glass. The user must carry context between conversations, choose the right controls, and assemble an overview of their work themselves.

The user wants one conversational point of contact for interacting with Glass: asking about their work, understanding the PR they are viewing, requesting an Agent review, and starting or continuing work with an Agent.

## Solution

Add one persistent **Global conversation** available throughout Glass. It works locally, independently of any repository, and uses Claude Code or pi through Glass's existing agent host. Opening or closing it preserves the user's place in the rest of the application.

Give it an explicit set of Glass tools through an authenticated HTTP MCP endpoint in the backend. Both Agent programs reach the same tool implementations and domain services. The user interacts with familiar Glass objects; MCP, credentials, and process boundaries are implementation details.

For example, the user can ask “What am I working on?”, “Review this PR”, or “Start an Agent in this repository to investigate this finding.” The Global conversation reads the relevant state or starts the requested operation, explains the actual outcome, and identifies the resulting Agent or Agent review. The user can ask for progress later. Automatically resuming the Global conversation when that work finishes is a later feature.

## User Stories

1. As a Glass user, I want one Global conversation, so that I have a consistent point of contact across my work.
2. As a Glass user, I want to open it from every area, so that I can ask for help where I am working.
3. As a Glass user, I want to dismiss and reopen it without losing messages, so that it fits around the work I am doing.
4. As a Glass user, I want opening it to preserve my current PR workspace or Agent, so that asking a question does not move me elsewhere.
5. As a Glass user, I want the same conversation when I change areas, so that I do not have to repeat myself.
6. As a Glass user, I want the conversation and my Unsent message to survive restarting Glass, so that I can continue later.
7. As a Glass user, I want to begin without linking a Local checkout or creating a worktree, so that asking about Glass does not require a coding workspace.
8. As a Glass user, I want support for Claude Code and pi using my existing logins, so that I can use an Agent program I already have.
9. As a Glass user, I want the existing model and Effort choices where supported, so that I can control how the Global conversation runs.
10. As a Glass user, I want a clear installation or login error when the selected Agent program cannot start, so that I know how to continue.
11. As a Glass user, I want answers to stream into the transcript, so that I can read them as they arrive.
12. As a Glass user, I want tool activity and failures visible in the transcript, so that I can understand what the conversation actually did.
13. As a Glass user, I want to stop a running Turn, so that I remain in control of the conversation.
14. As a Glass user, I want Queued messages and Steer to follow Glass's existing behavior, so that communicating during a Turn feels familiar.
15. As a Glass user, I want Questions and any supported Permission requests presented through existing controls, so that I can answer them directly.
16. As a Glass user, I want to know when a Turn was interrupted by quitting or losing its process, so that incomplete work is not presented as finished.
17. As a reviewer, I want “this PR” to identify the PR workspace and Revision I was viewing when I sent the message, so that my request targets the right change.
18. As a reviewer, I want that context to remain fixed if I navigate elsewhere during the Turn, so that the request cannot silently change targets.
19. As a Glass user, I want the active Agent identified when I ask about it, so that I do not have to copy its identifier.
20. As a Glass user, I want to see which PR or Agent accompanies my message, so that I can recognize an incorrect assumption.
21. As a Glass user, I want missing context stated clearly, so that “this PR” is not guessed from an unrelated Saved place.
22. As a reviewer, I want to ask about my PR lists and Queue, so that I can decide what to work on next.
23. As a reviewer, I want the conversation to read the current PR's description, changed material, and relevant discussions, so that it can answer questions about the change.
24. As a Glass user, I want to ask about my To-dos and recent Activity, so that I can recover the context of my work.
25. As a Glass user, I want to ask which Agents exist, what they have done, and which need an answer, so that I can find the work that needs me.
26. As a reviewer, I want to request an Agent review for an explicit PR and Revision, so that I can start the existing review workflow conversationally.
27. As a reviewer, I want to ask for an Agent review's current progress or result, so that I can check it from the same conversation.
28. As a Glass user, I want to start an Agent with an explicit repository, base branch, execution place, and initial message, so that I can delegate work through Glass.
29. As a Glass user, I want the conversation to discover valid execution choices and identify missing setup, so that it does not invent models, branches, or Sandbox providers.
30. As a Glass user, I want to send a message to an existing Agent, so that I can continue work without switching conversations.
31. As a Glass user, I want a message sent to a busy Agent to follow the existing Queued message rules, so that running work is handled consistently.
32. As a Glass user, I want created Agents and Agent reviews to appear in their existing areas, so that conversational actions produce ordinary, inspectable Glass objects.
33. As a Glass user, I want confirmed outcomes distinguished from started, failed, or uncertain operations, so that I can trust the conversation's account of its work.
34. As a Glass user, I want service failures and stale Revisions explained accurately, so that the conversation cannot bypass the rules of the corresponding UI action.
35. As a Glass user, I want existing repository Agents to remain independently usable, so that the Global conversation adds a convenient entry point to my workflows.
36. As a Glass user, I want the integration to leave my global Agent-program configuration alone, so that using Glass does not reconfigure my other tools.

## Implementation Decisions

- Introduce Global conversation as a distinct domain concept: one persistent, local conversation whose scope is Glass. Extend the glossary accordingly. Preserve Agent as a named conversation doing work in a worktree, Sandbox, or review checkout. Do not manufacture a repository or make repository identity optional throughout existing Agent APIs just to fit this feature.
- Reuse the agent host, Claude Code and pi adapters, Turn representation, transcript rendering, event persistence, and message controls where their contracts fit. Add the smallest explicit startup distinction needed for a Global conversation. Keep model execution in the host and Glass operations in backend domain services.
- Give the Global conversation a dedicated directory under Glass's local data and stable persisted identity. Starting it creates no git branch or worktree and requires no Local checkout. Start its runtime on demand. Persist its transcript, Unsent message, and selected Agent program/model/Effort using the existing storage patterns. Use existing selection conventions; do not add automatic provider fallback, multiple Global conversations, or cross-program transcript migration.
- Provide an accessible app-shell control and a dismissible conversation surface alongside the current area. Opening it must not change that area's route or Saved place. Keep shared state in Effect atoms rather than component-local state. Preserve the existing router and navigation-blocking behavior. Exact visual layout is an implementation choice; users must be able to operate both the conversation and the current area by keyboard.
- Capture active-area context when each message is sent. For a PR workspace include the structured PR reference and exact Revision; for an Agent include its stable identity. Retain this context with the message and show a readable label. Queued messages retain their captured context when eventually delivered. Tool calls use explicit targets; later navigation cannot retarget an earlier message. A previous Saved place is not an active selection. Include file or line information only where it is already available from an explicit user action; building general selection capture is deferred.
- Add an app-owned HTTP MCP endpoint to the existing backend listener, alongside the renderer's Effect RPC transport. Use Effect 4's MCP support and typed tool schemas. Define one explicit tool contract and handler set; adapters translate transport and program details rather than reimplementing domain rules. Respect the executable import boundaries and explicitly register any new transport owner in the boundary policy.
- Authenticate MCP independently with a conversation-runtime bearer credential. Issue it when starting the Global conversation's runtime, bind it to that conversation and permitted tool set, revoke it when the runtime ends, and issue a fresh credential on restart. Resolve caller identity from authentication on every request, separately from model-supplied operation targets. An MCP transport-session identifier is not caller authentication.
- Keep this credential separate from the renderer's per-launch backend secret. Configure routing so the MCP endpoint uses its own authentication rather than requiring the renderer's query token as well. Preserve authentication for all existing routes. Do not log bearer values or persist them in transcripts, ordinary database records, generated extensions, command arguments, or error messages. Keep request logging disabled where existing query-token authentication requires it.
- Pass the MCP endpoint and credential through the authenticated host startup contract only for the Global conversation. Do not grant this app-tool surface to repository or Sandbox Agents in this slice. Keep the endpoint local; no remote ingress, external client sign-in, or OAuth service is required.
- For Claude Code, attach the HTTP MCP server through runtime SDK registration, following T3 Code's approach of keeping credentials out of launch arguments. Verify the pinned SDK's actual interface before implementation. For pi, inject a generated extension that discovers the same endpoint's tool schemas and forwards calls, tool errors, and cancellation. Pass current credentials at runtime, clear inherited bridge credentials, and keep the reusable extension source credential-free. Do not write user-global MCP settings.
- Limit the Global conversation's tool surface to the specified Glass operations and supported conversational Questions. It should coordinate application work through these tools; project editing and shell execution remain the work of repository Agents. Do not inherit arbitrary project tools or unrelated MCP servers into this role, or silently broaden access if an adapter cannot enforce its intended tool set. Existing model discovery and authentication must continue to work.
- The first tool set supports reading PR lists, Queue, To-dos, bounded recent Activity, Agent listings, waiting state, and bounded transcript material. It also supports reading a specified PR's material at a Revision, starting an Agent review, reading its state/result, discovering the existing setup choices needed to start an Agent, creating an Agent, and sending a message to an Agent. Tool names and grouping can follow existing conventions; these capabilities define the scope.
- Use the same domain services as UI actions, including existing tagged failures, model availability, Local checkout requirements, Sandbox-provider support, message-queuing rules, and stale-Revision checks. Keep handlers thin and transport-agnostic services reusable. Reading PR material must not call a UI-opening operation that records a user opening or changes Queue state. Record user-requested actions according to the existing Activity definitions; conversation messages and background reads are not Activities.
- Mutating tools return the created object's identity or the operation's actual accepted state. Starting an Agent review is distinct from completing it; accepting a message is distinct from the Agent finishing its Turn. Surface ordinary domain failures as tool failures the model can explain. On an uncertain mutation result, do not blindly repeat creation or messaging; inspect available state and report uncertainty. No general command/event framework is required.
- Forward cancellation through the bridge. Stopping the Global conversation's Turn must not present a late response as a completed Turn, undo a mutation already accepted by a service, or automatically stop a separately created Agent. Re-read state when the result is uncertain. Existing Questions and Permission requests remain attached to the conversation that owns them; the Global conversation does not automatically answer another Agent's requests.
- Preserve current local lifetime semantics: quitting Glass interrupts the Global conversation's running Turn, and restarting restores its conversation history without promising background continuation. Existing Sandbox Agent behavior remains as defined by Glass. A later user message can read work status; this slice adds no automatic wake or persistent obligation tracking.
- Update relevant architecture documentation to explain the Glass-scoped conversation and shared MCP transport. Reuse the existing backend and host architecture; a separate daemon, provider framework, supervisor hierarchy, or replacement for Effect RPC is unnecessary.

## Testing Decisions

- Prefer observable behavior at the highest existing application boundary. The agreed primary acceptance seam is the isolated Electron end-to-end fixture: send a Global conversation message, exercise the actual host-to-backend MCP connection, and assert a visible result plus resulting Glass state. Reuse the fixture's real pinned Agent programs with controlled model responses and isolated GitHub/data sources. Do not invent another fake Agent-program protocol.
- Keep desktop coverage focused on distinct user behaviors: the same conversation remains available across area changes; a request uses its captured PR/Revision even after navigating; an Agent created conversationally appears in Agents; and restarting restores history with an interrupted Turn represented accurately. Reuse existing transcript and composer coverage rather than duplicating every existing control's tests for a second placement.
- Test the backend MCP adapter through real HTTP discovery and invocation against an isolated backend and database. Verify representative reads, an Agent review start, and Agent creation or messaging through existing services. Assert service outcomes and domain errors rather than internal method calls or schema snapshots. Read-only operations must not synthesize Activity or navigation side effects.
- Add focused boundary cases for missing, incorrect, and revoked credentials; fresh credentials after runtime restart; caller identity distinct from operation targets; invalid inputs and stale Revisions; and cancellation of an in-flight call. Use explicit event coordination so a late response or already-accepted mutation can be checked deterministically. These cases belong at the MCP/backend boundary rather than scattered credential helper tests.
- Reuse existing adapter integration and recording seams to prove that both Claude Code and pi discover and execute the same Glass tools, preserve tool failures, and forward cancellation. Changes to what Glass sends the programs require refreshing real session recordings under the existing recording policy. Do not treat hand-written launch-option assertions as proof that an Agent program can use the bridge.
- Prior art includes the local-Agent Electron acceptance test with a real Permission request, Agent service tests that start an isolated backend and restart it, transcript tests for stopped Turns and late events, and Claude Code/pi integration tests replaying real recorded sessions. Extend those fixtures and conventions instead of creating a parallel test harness.
- Wait on observable events and existing eventual/DOM helpers. Do not order work with sleeps, assert elapsed durations, or introduce success-path deadlines near test timeouts. Run the normal checks and focused tests appropriate to the implementation; avoid repetitive smoke coverage of unchanged features.
- Kevin confirmed these test boundaries: Electron acceptance as the primary seam, supported by focused backend credential-rejection/cancellation tests and existing Claude Code/pi recording tests for provider compatibility.

## Out of Scope

- Durable obligations, worker-completion wakes, proactive notifications, automatic continuation, scheduled work, or autonomous multi-step supervision after a Global conversation Turn ends.
- Automatic application navigation, controlling the UI with clicks, or a general API for selecting files and diff lines. The user can inspect results through existing areas.
- GitHub publishing tools, submitting Reviews, adding Drafts, sending Replies, merging PRs, pushing commits, or changing reactions and discussion resolution through the Global conversation.
- New conversational mutations for Queue, To-dos, Settings, or followed repositories; Tour creation; deleting Agents; and automatically answering their Questions or Permission requests. These operations can be considered after the initial tool set is useful.
- A hierarchy of supervisors, new delegation policies, external MCP clients, ACP compatibility, OAuth, remote MCP access, or granting Glass-wide tools to every Agent.
- Shell execution or project editing by the Global conversation, new execution places, changing Sandbox provisioning, or making local work outlive Glass.
- Multiple Global conversations, cross-program transcript migration, general memory/search infrastructure, tool plugins, deferred tool discovery, and a generic workflow or event-sourcing framework.
- Replacing existing PR, Agent, review, or To-do screens, or requiring the Global conversation to use them.

## Further Notes

Kevin agreed to begin with the Global conversation and tool bridge, with durable follow-through deferred. The inspiration from FirstMate is one accountable conversational relationship across existing work; its terminal inference, supervisor hierarchy, and operational machinery are not requirements for Glass.

The T3 Code source inspection supports an app-owned HTTP MCP endpoint, conversation-runtime caller credentials, thin handlers over shared application services, Claude runtime MCP registration, and pi extension injection. This research was static: it does not prove compatibility with Glass's pinned SDK or pi version. Verify those interfaces during implementation and keep the contract the same across both programs.

The relevant architectural context is the backend's ownership of credentials and persistence, renderer state in routes and Effect atoms, execution through an agent host, reuse of existing program credentials, and tests replaying real Agent-program sessions. The Global conversation extends the repository-scoped model deliberately; it does not require moving execution into the renderer or backend service process.

## Comments

- Kevin confirmed: “Yes, use these test boundaries.” Use the existing Electron end-to-end boundary to send a Global conversation message, exercise the real MCP bridge, and verify the result in Glass; add focused backend credential-rejection and cancellation tests, and reuse Claude Code/pi recording tests for provider compatibility.
