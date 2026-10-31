# Fake Sandboxes

A Sandbox provider Plugin (ADR 0008) for trying the plugin system without a Sandbox platform. Each
"Sandbox" is a folder under the system's temp folder: the Plugin clones the repository there and
runs the agent host on this device, with `claude.mjs`, a fake Claude Code, in place of the real
one. The seam it implements is `@glass/plugin`.

## Install

Copy this folder into Glass's plugins folder, then restart Glass. Run from the repository root:

```sh
mkdir -p ~/.project-glass/plugins
cp -r examples/fake-sandboxes ~/.project-glass/plugins/
```

```powershell
New-Item -ItemType Directory -Force ~/.project-glass/plugins
Copy-Item -Recurse examples/fake-sandboxes ~/.project-glass/plugins/
```

The Plugin imports only Node and the types in `@glass/plugin`, so it needs no install. `pnpm dev:fake`
keeps its data in a fresh temp folder, so it won't see the Plugin; use `pnpm dev`.

## What's fake

Its Sandboxes run only Claude Code, offering its models and efforts. Their Agents answer every
message with "Fake reply from <model> at <effort> effort to: …" and need no login. Cloning uses your
own git credentials.
