# 03: Local skills for Sandbox Agents

**What to build:** When creating a Sandbox Agent, the user can choose to give it their Local skills, so it works as a local Agent would. The picker warns when chosen sources share a skill name. See the PRD (`.scratch/skill-packs/PRD.md`) and the GLOSSARY's **Local skills**.

**Blocked by:** 02 (Agents get their Skill packs)

**Status:** ready-for-agent

- [x] The new-Agent picker shows a Local skills checkbox only for Sandbox placements (local Agents always have Local skills because the program reads them itself); it is part of the remembered last choice.
- [x] `NewAgent` carries whether a Sandbox Agent includes Local skills; the Agent keeps that choice for its whole life. The Global conversation's create-Agent tool passes no Local skills.
- [x] Each time a Sandbox Agent's program starts, the backend reads the folders that program reads on this device (`~/.claude/skills` for Claude Code; `~/.agents/skills` and `~/.pi/agent/skills` for pi), following symlinks, and sends them as one more source in the Work role.
- [x] Claude Code receives Local skills as one more generated plugin, named as settled in ticket 02's SDK findings; pi receives them as `--skill` paths.
- [x] The Agent's details show "· Local skills" when it has them, such as "team @ ae5650f · Local skills".
- [x] The picker warns, without blocking, when chosen packs and the chosen program's Local skills share a skill name, naming the skills; the copy states which one the Agent uses, based on ticket 02's findings. It does not look up the repository's own skills.
- [x] The Sandbox Agent Electron acceptance test gains one path: create a Sandbox Agent with a pack and Local skills, and see both in its Command list and details. It waits on observable events, with no sleeps or timing assertions.

## Comments

**Naming (2026-11-09).** Claude Code can't load an un-namespaced plugin (ticket 02's findings), so a Sandbox Agent's Local skills are the plugin `local` (`/local:grilling`), and `local` is no longer a valid Skill pack name. Glass sends Local skills before the Agent's packs, so in pi a Local skill wins over a pack's skill of the same name, as it does for a local Agent; the picker's warning says so. In Claude Code the warning names each namespaced command instead.

**Details.** `Agent.localSkills` records whether Glass sends the Local skills, so it is only ever true for Sandbox Agents, and only they show "· Local skills". A local Agent's program reads them itself.

**Command list.** A Sandbox Agent's host lists nothing until its Sandbox is made, and the desktop never asked again, so a new Sandbox Agent's Command list stayed empty. Its commands and files now list again once its Sandbox is reachable.
