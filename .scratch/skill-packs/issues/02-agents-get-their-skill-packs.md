# 02: Agents get their Skill packs

**What to build:** When creating an Agent, the user picks which Skill packs it gets, and the Agent can run those skills from its Command list, in both Claude Code and pi, local or Sandbox. The Agent keeps the packs and commits it was created with for its whole life, and its details show them. See the PRD (`.scratch/skill-packs/PRD.md`).

**Blocked by:** 01 (Manage Skill packs in Settings)

**Status:** ready-for-agent

- [x] Before building, verify against the pinned Claude Agent SDK (0.3.309) how local-plugin skills are named in the Command list, and whether an un-namespaced plugin is possible (ticket 03 needs that answer for Local skills). Confirm whether pi's `--skill` paths take precedence over skills pi discovers itself. Record both findings in the ticket's comments.
- [x] The new-Agent picker lists the user's Skill packs; the last choice is kept on this device as the picker's starting point.
- [x] `NewAgent` carries the chosen packs; at creation the backend records each pack with its current commit on the Agent, and the choice never changes afterwards. The Global conversation's create-Agent tool passes no packs.
- [x] Updating or removing a pack leaves existing Agents on the commit they were created with; a pinned commit's files are kept while any pack or Agent references them and deleted once neither does.
- [x] `StartAgent`'s Work role carries the Agent's skill files grouped by source (each pack by name). The host writes each source into a per-Agent temp folder, preserving executable bits, and removes it when the program ends. Skills travel through this RPC for both placements; the Sandbox provider contract (`@glass/plugin`) is unchanged.
- [x] Claude Code: each pack becomes a generated local plugin named after the pack, passed through the SDK's `plugins` option with `skipMcpDiscovery` set; Work Agents keep their default setting sources. `/team:<skill>` appears in the Command list.
- [x] pi: one `--skill <path>` per sent skill; `/skill:<skill>` appears in the Command list.
- [x] Sent skills add to the repository's own skills and the program's defaults; they replace nothing.
- [x] Agent reviews, Follow-ups, Tours, and the Global conversation keep their current lockdown unchanged.
- [x] The Agent's details show its packs and commits, such as "team @ ae5650f".
- [x] Recording tests for each program show an Agent started with a pack listing the pack's skill as a Command; real recordings are refreshed under the existing recording policy rather than asserting launch arguments.
- [x] Backend tests cover that existing Agents keep their pins after Update and that removing a pack keeps files an Agent still references.

## Comments

**SDK and pi findings (2026-11-09).** Probed the pinned Claude Agent SDK 0.3.309's handshake with generated local plugins, and read pi-coding-agent 1.3.0's skill loader.

- Claude Code names a local plugin's skills `<plugin>:<skill>`, where `<plugin>` is the manifest's `name` (`.claude-plugin/plugin.json`), or the plugin folder's name when there is no manifest. `<skill>` is the `SKILL.md` frontmatter `name`, not its folder. A plugin whose manifest name is empty doesn't load. So an un-namespaced plugin isn't possible: Local skills for a Sandbox Agent (ticket 03) need a namespace of their own. Each plugin skill also gets its bare name as an alias (`team:greet` answers to `/greet`), which the Command list doesn't show.
- pi loads `--skill` paths after the skills it discovers itself (`~/.pi/agent/skills`, `~/.agents/skills`, the project's), and keeps the first skill of a name. A discovered skill wins over a sent one of the same name, and between sent skills the first `--skill` wins. pi lists every skill as `/skill:<name>`, with no pack namespace, so two packs' same-named skills clash in pi.
- Glass sends an Agent's packs in name order, so in pi the alphabetically first pack's skill wins between two packs' same-named skills. Ticket 03's warning copy should say so.
