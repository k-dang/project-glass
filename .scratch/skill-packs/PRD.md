Status: ready-for-agent

# Skill packs

## Problem Statement

A local Agent has whatever skills the user keeps on this device, because Claude Code and pi read the
user's skill folders themselves. A Sandbox Agent has none of them: Glass hands a Sandbox provider
only a repository, a branch, and the agent host, so the Agent gets only what the repository or the
provider's image happens to contain. Neither kind of Agent can be given a known, shared set of
skills, such as a team's or the user's published collection on GitHub, and nothing records which
skills an Agent ran with.

## Solution

Add **Skill packs**: named sets of skills from one GitHub folder, each pinned to a commit. The user
adds packs in Settings, previewing the skills and commit before confirming, and moves a pack's pin
only by updating it explicitly. When creating an Agent, the user picks which packs it gets, and, for
a Sandbox Agent, whether it gets their **Local skills**. An Agent keeps that choice, and the pack
commits it was created with, for its whole life.

The backend gathers the chosen skills and sends them to the agent host when the Agent's program
starts, so local and Sandbox Agents work the same way and Sandbox providers change nothing. Sent
skills add to the repository's own skills and the Agent program's defaults; they replace nothing.

For example, the user adds `https://github.com/k-dang/skills/tree/main/skills/kstack` as the pack
`kstack`, then creates a Sandbox Agent with kstack and Local skills ticked. The Agent can run
`/kstack:architect` in Claude Code and the user's own `/grilling`, and its details show
"kstack @ ae5650f · Local skills".

## User Stories

1. As a Glass user, I want to add a Skill pack by pasting a GitHub URL, so that Agents can use a
   published collection of skills.
2. As a Glass user, I want to paste either a folder URL (`…/tree/<ref>/<path>`) or a repository URL,
   so that I can add a pack from wherever its skills live.
3. As a Glass user, I want a URL that points at a single skill folder to become a pack of that one
   skill, so that I can share one skill without a collection around it.
4. As a Glass user, I want packs from private repositories to work with my existing GitHub
   Connection, so that I can use my team's skills.
5. As a Glass user, I want to see a pack's skills, with names and descriptions, and the commit it
   resolved to before I add it, so that I catch a wrong path or an empty folder.
6. As a Glass user, I want skills that can't load (malformed `SKILL.md`, no description) listed as
   skipped with the reason, while the rest are added, so that one broken skill doesn't block a pack.
7. As a Glass user, I want to name a pack, starting from its folder's name and unique among my
   packs, so that its skills are recognisable as `/name:skill`.
8. As a Glass user, I want a pack to stay on the commit I added it at until I update it, so that
   what my Agents run can't change underneath me.
9. As a Glass user, I want to update a pack and see which skills were added, removed, or changed
   before I confirm, so that I know what new Agents will get.
10. As a Glass user, I want existing Agents to keep the commit they were created with after I update
    or remove a pack, so that an Agent's skills never change while it exists.
11. As a Glass user, I want to remove a pack so that it no longer appears for new Agents.
12. As a Glass user, I want to pick Skill packs when creating an Agent, so that it gets the skills it
    needs.
13. As a Glass user, I want to choose whether a Sandbox Agent gets my Local skills, so that it can
    work as a local Agent would.
14. As a Glass user, I want the picker to start from my last choice, so that creating similar
    Agents takes one click.
15. As a Glass user, I want to be warned in the picker when two chosen sources have a skill of the
    same name, naming the skills, so that I know which one the Agent may use.
16. As a Glass user, I want a Sandbox Agent's Local skills to reflect my folders as they are when its
    program starts, as they do for a local Agent.
17. As a Glass user, I want pack skills to appear in the Agent's Command list, so that I can run
    them with `/`.
18. As a Glass user, I want an Agent's details to show the packs and commits it was created with and
    whether it has Local skills, so that I can tell why it has or lacks a skill.
19. As a Glass user, I want Agent reviews, their Follow-ups, Tours, and the Global conversation to be
    unaffected, so that their locked-down behaviour stays predictable.

## Implementation Decisions

- **Vocabulary.** Skill pack and Local skills are defined in `GLOSSARY.md`. Avoid "plugin" in the
  domain: it already names Glass Plugins (Sandbox providers), and Claude Code plugins are only the
  delivery mechanism for one Agent program.
- **Pack sources.** GitHub only, read through the user's existing Connection. Accept tree URLs
  (`github.com/<owner>/<repo>/tree/<ref>/<path>`) and repository URLs (default branch, repository
  root). No other git hosts and no local-folder packs.
- **What counts as a skill.** If the pack's folder contains `SKILL.md`, the pack is that one skill.
  Otherwise discover folders containing `SKILL.md` recursively, without descending into a folder
  once it is a skill. Other files at the pack's top level (for example kstack's `UPSTREAM.md`) are
  ignored. A skill whose `SKILL.md` doesn't parse or has no description is skipped and reported in
  the preview.
- **Pinning.** A pack remembers the ref from its URL and the commit that ref resolved to. Update
  re-resolves the ref, shows what changed against the current pin, and moves the pin on
  confirmation. A URL whose ref is already a commit has nothing to update. There is no automatic
  update check.
- **Names.** A pack's name defaults to its folder's (or repository's) name, must be unique, follows
  skill-name rules (lowercase letters, digits, hyphens), and is fixed once added. It is the
  namespace Claude Code shows (`/kstack:architect`).
- **Storage.** Pack metadata and the files of each pinned commit live in Glass's database, so an
  Agent's row and the pins it references stay the one record of that Agent (as ADR 0010 already
  treats Sandbox state). A pinned commit's files are kept while a pack or any Agent references them
  and deleted once neither does. No new Storage group.
- **Choice on the Agent.** `NewAgent` gains the chosen Skill packs and, for Sandbox Agents, whether
  to include Local skills. At creation the backend records each chosen pack with its current
  commit on the Agent. The choice never changes afterwards. The Global conversation's create-Agent
  tool passes no packs and no Local skills.
- **Picker.** The new-Agent flow lists the user's Skill packs, plus a Local skills checkbox only for
  Sandbox placements (local Agents always have Local skills because the Agent program reads them
  itself). The last choice is kept on this device as the picker's starting point. The picker warns,
  without blocking, when chosen packs and the chosen program's Local skills share a skill name; it
  does not look up the repository's own skills.
- **Which Local skills.** A Sandbox Agent gets the folders its Agent program reads on this device:
  `~/.claude/skills` for Claude Code; `~/.agents/skills` and `~/.pi/agent/skills` for pi. Follow
  symlinks (the user's folders are mostly links into dotfiles). Read them each time the Agent's
  program starts, not once at creation.
- **Delivery to the host.** `StartAgent`'s Work role carries the Agent's skills as files grouped by
  source (each pack by name, and Local skills). The host writes each source into a per-Agent temp
  folder, preserving executable bits, and removes it when the program ends, following the pi
  adapter's `lockedDownFlags` pattern. Skills reach the host through this RPC for both placements,
  never through the Sandbox provider; `@glass/plugin` is unchanged.
- **Claude Code.** Each pack becomes a generated local plugin (manifest named after the pack, with
  `skills/`) passed through the SDK's `plugins` option, with `skipMcpDiscovery` set. Local skills
  for a Sandbox Agent become one more generated plugin. Work Agents keep their default setting
  sources. Verify against the pinned SDK (0.3.309) how plugin skills are named in the Command list
  and whether an un-namespaced Local-skills plugin is possible; if not, settle naming before
  building.
- **pi.** Pass one `--skill <path>` per sent skill. pi keeps the first skill it finds for a
  name and warns; confirm whether `--skill` paths come before discovered skills and note the result
  in the picker's warning copy.
- **Roles.** Only Work Agents get skills. Agent reviews, Follow-ups, Tours, and the Global
  conversation keep their current lockdown unchanged.
- **Agent details.** Show the Agent's sources, such as "kstack @ ae5650f · Local skills". Pack skills
  appear in the existing Command list without new work.
- **No size limit.** The preview shows what a pack contains; revisit only if a real pack hits a
  transport limit.

## Testing Decisions

Proposed; not yet confirmed with Kevin.

- Test the pack-creation flow at the backend boundary against recorded or fixture GitHub responses:
  tree and repository URLs, a single-skill folder, recursive discovery, skipped skills with reasons,
  duplicate names, and an inaccessible repository. Test Update's change summary and that existing
  Agents keep their pins, and that removing a pack keeps files an Agent still references.
- Test host delivery once per Agent program using the existing recording seams: an Agent started
  with a pack lists the pack's skill as a Command (Claude Code `/kstack:<skill>`, pi
  `/skill:<skill>`). Refresh real recordings under the existing recording policy rather than
  asserting launch arguments.
- Extend the Sandbox Agent Electron acceptance test (`apps/desktop/e2e/sandboxAgent.spec.ts`) with
  one path: create a Sandbox Agent with a pack and Local skills, and see both in its Command list
  and details.
- Wait on observable events and existing helpers; no sleeps or timing assertions.

## Out of Scope

- MCP servers for Agents (deferred until skills land).
- Changing an Agent's skills after creation.
- Per-skill selection within a source.
- Automatic update checks, update notifications, and renaming packs.
- Non-GitHub sources and local-folder packs.
- Suppressing Local skills for local Agents.
- Detecting clashes with a repository's own skills before the Agent starts.
- Skills for Agent reviews, Follow-ups, Tours, and the Global conversation, and Skill packs or Local
  skills for Agents the Global conversation creates.
- Size limits on packs or Local skills.

## Further Notes

Research this design rests on:

- Glass's Work role adds no options to either program, so local Work Agents load all of Claude
  Code's setting sources (the pinned SDK's default when `settingSources` is omitted) and pi's
  defaults. Review and Global roles lock both down.
- The pinned Claude Agent SDK takes local plugins (`plugins: [{ type: "local", path }]`), which load
  skills, and a `skills` filter; pi takes `--skill <path>`, discovers skills recursively, and reads
  `~/.agents/skills` and `~/.pi/agent/skills`.
- kstack shares four skill names with the user's Local skills (`bro`, `no-comments`,
  `create-verification-skill`, `maintain-verification-skill`), so clashes are an expected case, not
  an edge case.
- The agent host is the same for both placements and already receives per-conversation payloads
  through `StartAgent`'s role (the Review brief), which is why skills need no change to the Sandbox
  provider contract.
