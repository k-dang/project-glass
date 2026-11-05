# 04: Act through the conversation — Agent review + Agent

**What to build:** Through the same Global conversation, the user can request an Agent review for an explicit PR and Revision and start or continue an Agent with explicit repository, base branch, execution place, and initial message, with created objects appearing in their existing areas and outcomes explained accurately.

**Blocked by:** 03: Bridge the conversation to Glass reads via MCP

**Status:** ready-for-agent

- [ ] Keywords like “Review this PR” start a real Agent review, and the user can ask for its current progress or result from the same conversation with started vs completed clearly distinguished
- [ ] The conversation discovers valid execution choices (models, branches, Sandbox providers, Local checkout requirements) and identifies missing setup instead of inventing them
- [ ] Created Agents and Agent reviews appear in their existing areas; sending a message to an existing Agent follows the existing Queued message rules for a busy Agent
- [ ] Mutations return the created object's identity or actual accepted state, surface ordinary domain failures (including stale Revisions) as tool failures the model can explain, and never blindly repeat on an uncertain result
- [ ] Stopping the Global conversation's Turn presents no late response as completed, does not undo an accepted mutation, and does not automatically stop a separately created Agent
