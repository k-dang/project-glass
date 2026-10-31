# Fake Sandboxes

A Sandbox provider Plugin (ADR 0008) for trying the plugin system without a Sandbox platform. Each
"Sandbox" is a folder under the system's temp folder: the Plugin clones the repository there and
runs the agent host on this device, with `claude.mjs`, a fake Claude Code, in place of the real
one. The seam it implements is `@glass/plugin`.

## Install

Copy this folder into Glass's plugins folder, then restart Glass. Run from the repository root:

```sh
cp -r examples/fake-sandboxes ~/.project-glass/plugins/
```

```powershell
Copy-Item -Recurse examples/fake-sandboxes ~/.project-glass/plugins/
```

The Plugin imports only Node and the types in `@glass/plugin`, so it needs no install.

## What's fake

Claude Code Agents answer every message with "Fake reply to: …" and need no login. pi Agents run the pi
on your `PATH`, logged in as you. Cloning uses your own git credentials.
