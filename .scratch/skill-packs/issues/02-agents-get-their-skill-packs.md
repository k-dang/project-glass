# 02: Agents get their Skill packs

**What to build:** When creating an Agent, the user picks which Skill packs it gets, and the Agent can run those skills from its Command list, in both Claude Code and pi, local or Sandbox. The Agent keeps the packs and commits it was created with for its whole life, and its details show them. See the PRD (`.scratch/skill-packs/PRD.md`).

**Blocked by:** 01 (Manage Skill packs in Settings)

**Status:** ready-for-agent

- [ ] Before building, verify against the pinned Claude Agent SDK (0.3.309) how local-plugin skills are named in the Command list, and whether an un-namespaced plugin is possible (ticket 03 needs that answer for Local skills). Confirm whether pi's `--skill` paths take precedence over skills pi discovers itself. Record both findings in the ticket's comments.
- [ ] The new-Agent picker lists the user's Skill packs; the last choice is kept on this device as the picker's starting point.
- [ ] `NewAgent` carries the chosen packs; at creation the backend records each pack with its current commit on the Agent, and the choice never changes afterwards. The Global conversation's create-Agent tool passes no packs.
- [ ] Updating or removing a pack leaves existing Agents on the commit they were created with; a pinned commit's files are kept while any pack or Agent references them and deleted once neither does.
- [ ] `StartAgent`'s Work role carries the Agent's skill files grouped by source (each pack by name). The host writes each source into a per-Agent temp folder, preserving executable bits, and removes it when the program ends. Skills travel through this RPC for both placements; the Sandbox provider contract (`@glass/plugin`) is unchanged.
- [ ] Claude Code: each pack becomes a generated local plugin named after the pack, passed through the SDK's `plugins` option with `skipMcpDiscovery` set; Work Agents keep their default setting sources. `/team:<skill>` appears in the Command list.
- [ ] pi: one `--skill <path>` per sent skill; `/skill:<skill>` appears in the Command list.
- [ ] Sent skills add to the repository's own skills and the program's defaults; they replace nothing.
- [ ] Agent reviews, Follow-ups, Tours, and the Global conversation keep their current lockdown unchanged.
- [ ] The Agent's details show its packs and commits, such as "team @ ae5650f".
- [ ] Recording tests for each program show an Agent started with a pack listing the pack's skill as a Command; real recordings are refreshed under the existing recording policy rather than asserting launch arguments.
- [ ] Backend tests cover that existing Agents keep their pins after Update and that removing a pack keeps files an Agent still references.
