# 01: Manage Skill packs in Settings

**What to build:** The user can add, update, and remove Skill packs in Settings. Adding takes a GitHub URL, previews the pack's skills and the commit it resolved to, and stores the pack under a name the user confirms. Updating shows what changed against the current pin before moving it. Removing takes the pack out of the list. See the PRD (`.scratch/skill-packs/PRD.md`) for the full design; use the GLOSSARY's **Skill pack** vocabulary and avoid "plugin" in the domain.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] Accepts tree URLs (`github.com/<owner>/<repo>/tree/<ref>/<path>`) and repository URLs (default branch, repository root), read through the user's existing GitHub Connection, private repositories included. Other hosts are rejected with a clear message.
- [x] A folder that contains `SKILL.md` is a pack of that one skill; otherwise skills are discovered recursively, without descending into a folder once it is a skill. Other top-level files are ignored.
- [x] The preview lists each skill's name and description and the resolved commit; skills whose `SKILL.md` doesn't parse or has no description are listed as skipped with the reason, and the rest can still be added.
- [x] An empty folder, a wrong path, and an inaccessible repository each produce a clear error in the preview.
- [x] The pack's name defaults to its folder's (or repository's) name, must be unique among the user's packs, follows skill-name rules (lowercase letters, digits, hyphens), and is fixed once added.
- [x] Pack metadata (URL ref and pinned commit) and the files of the pinned commit are stored in Glass's database, with no new Storage group.
- [x] Update re-resolves the ref, shows skills added, removed, and changed against the current pin, and moves the pin only on confirmation. A pack whose ref is already a commit offers nothing to update. There is no automatic update check.
- [x] Remove takes the pack off the list; a pinned commit's files are deleted once no pack references them (ticket 02 extends this to Agent references).
- [x] Backend-boundary tests against recorded or fixture GitHub responses cover: tree and repository URLs, a single-skill folder, recursive discovery, skipped skills with reasons, duplicate names, an inaccessible repository, and Update's change summary.
