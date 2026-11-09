# Prompt: build a Sandbox provider Plugin

Copy the block below into the coding agent of your choice, run from an empty folder.

```text
Build a Glass Sandbox provider Plugin for my Sandbox platform.

Glass is at https://github.com/k-dang/project-glass. Read these before writing code:

- `docs/adr/0010-sandboxes-come-from-provider-plugins.md`: why providers work the way they do.
- `packages/plugin/src/index.ts`: how Glass loads Plugins and the interface to implement. It isn't
  published, so copy it into the Plugin folder as `glass-plugin.ts` and import its types from there.
- `examples/fake-sandboxes/`: a working provider that runs its "Sandboxes" on this device.

Then ask me what you need to know about my platform, such as how it creates, reaches, and deletes
a machine, which Agent programs to offer, and which logins a Sandbox needs.

When done, tell me how to install the Plugin and how to check it: start an Agent in the new kind of
Sandbox, send it a message, then remove the Agent and confirm the machine is gone.
```
