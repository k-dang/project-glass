# Fake Sandboxes

A Sandbox provider Plugin (ADR 0008) for trying the plugin system without a Sandbox platform. Each
"Sandbox" is a folder under the system's temp folder: the Plugin clones the repository there and
runs the agent host on this device, with `claude.mjs`, a fake Claude Code, in place of the real
one. The seam it implements is `@glass/plugin`.

## Install

Add a Plugin file that re-exports this one, then restart Glass. Run from the repository root:

```sh
echo "export { default } from \"$PWD/examples/fake-sandboxes/index.ts\"" > ~/.project-glass/plugins/fake-sandboxes.ts
```

In PowerShell, keep the path's slashes forward, as a backslash starts an escape in the string:

```powershell
$example = "$PWD/examples/fake-sandboxes/index.ts".Replace("\", "/")
Set-Content ~/.project-glass/plugins/fake-sandboxes.ts "export { default } from `"$example`""
```

Glass loads the re-export from its plugins folder, so this file and its imports resolve from the
repository. A copy or link of the folder would not find `effect`.

## What's fake

Claude Code Agents answer every message with "Fake reply to: …" and need no login. pi Agents run the pi
on your `PATH`, logged in as you. Cloning uses your own git credentials.
