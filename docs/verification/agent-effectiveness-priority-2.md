# Agent effectiveness: verification recipes

Verified on Windows, 2026-11-01, with pinned Node 24.21.0 and pnpm 11.10.0.
All UI runs used isolated fake GitHub and fake model providers. No feedback was published to live GitHub.

## Implementation

- GitHub defaults to fake; explicit real selection remains. The fake backend owns its GitHub server and still rejects explicit `--github fake`.
- Navigation uses octocat and working Agents, with one Saved place per area.
- Agent reviews and Agent changes have dedicated indexed recipes, based on existing E2E scenarios. The demo model reuses the E2E command fixture for two fixed file-writing messages.
- Text waits include accessible StaticText in shadow-root diffs. Actual execution exposed that body.innerText alone missed visible diff lines.
- Existing live recipes now explicitly select real GitHub. Other existing coverage, including Ask described under Drafts, was not treated as absent merely because it lacked a dedicated index entry.

## Executed runs

Evidence paths are relative to the worktree and gitignored; screenshots were visually inspected.

- `audit-default`: default launch, doctor, initial and Agents snapshots, Settings identity, Back/Forward and Settings reload. Doctor reported real backend, fake GitHub at 127.0.0.1:50681, CDP 50684. `evidence/fake-github.log` records `GET /user -> ok`. Before stop, storage existed under `.verify/audit-default/state/home/.project-glass/glass.db`, logs under its `.glass/logs`, and Electron storage under `state/user-data`. Evidence: `.verify/audit-default/evidence/`.
- `audit-demo`: fake-backend launch and doctor; Agent review generated, read beside Changes and shown as an opening on Overview; both Dashboard Continue cards and each destination exercised. Evidence: `.verify/audit-demo/evidence/agent-review.png`, `review-overview.png`, `both-places.png`, and matching snapshots.
- `audit-changes`: fake-backend launch and doctor; demo pi Agent wrote notes.txt, Changes held its first Revision while a second Turn wrote more.txt, Show latest displayed both. Settings/Activity preserved PR Changes and default.json; Dashboard reload preserved both Saved places and each Continue link restored its destination. Evidence: `.verify/audit-changes/evidence/agent-changes.png`, `held-changes.png`, `latest-changes.png`, `preserved-changes.png`, `reloaded-places.png`, and matching snapshots.
- `audit-connection`: omitted GitHub selection with fake mode 401; doctor, Settings failure, fake switched to ok, Try again restored octocat. Evidence: `.verify/audit-connection/evidence/`; fake-github.log records 401 then ok.

Every run completed stop, reporting its backend port closed. `list` reported no live runs. State directories were removed by stop; evidence survives.

Explicit real selection was checked without network access: `launch --github real --run audit-default` passed selection and stopped at the existing-run guard before any provider or Electron startup. Its output is in `audit-default/evidence/explicit-real-selection.txt`. Focused tests also directly assert real selection. Explicit fake GitHub with the fake backend was rejected before launch.

## Checks and limits

- `pnpm check`: passed formatting, lint, and types.
- `pnpm --filter @glass/server test test/verifyHelper.test.ts`: 2 passed, including default/explicit/invalid selections and backend ownership.
- `git diff --check`: passed.

The initial build attempt failed while dependencies were being installed; the subsequent full build and launches succeeded. The first Agent diff text wait timed out despite visible content; after adding the accessibility fallback, the same diff text wait passed.

Unverified here: live GitHub/model authentication or quality; cross-process Saved place persistence after a full app restart; changed-Revision/identity fallback; later-Chapter Tour restoration; unsent Review summary preservation; existing feedback publishing and other legacy live-only recipes. No result is inferred from tests for those paths. The incidental Tours recipe default/fixture edits were not executed as a full Tour run.

Before filing the PR, the base helper from origin/main was launched as `pr-base-default` with omitted GitHub selection, `--no-build --no-credentials --fail-backend-start`, and GLASS_GITHUB_API_URL pinned to the closed loopback port 1. Its run state recorded `github: real`, reproducing the old default without contacting GitHub. Startup failed as requested and stop cleaned up. Launch output is retained in `.verify/pr-base-default-launch.log`. The focused helper tests were rerun: 2 passed.
