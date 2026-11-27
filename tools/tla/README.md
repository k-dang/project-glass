# TLA+ models

The `verify-*` skills under `.agents/skills/` each keep a TLA+ model of one Glass state machine in their `model/` folder. This folder holds the runner they share.

```sh
node tools/tla/tlc.ts <path/to/Model.tla> --mutants
```

The first run installs the pinned Java and TLC from [`mise.toml`](mise.toml) and needs the network. A run takes seconds.

## What a model folder holds

- `Model.tla` and `Model.cfg`: the model, its bounds, and its rules (`INVARIANTS` and `PROPERTIES`). The config must set `Broken = {}`.
- `mutants.json`: each mutant is a name in `Broken` that turns on one broken variant of the code, mapped to the rule it must break. `Mutant("Name")` in the model marks where.
- `findings.json` (optional): rules the current code breaks, each with its finding in one sentence.

## How the runner reads a model

1. It checks every rule not in `findings.json`. All must hold.
2. It checks each rule in `findings.json` alone. Each must still break. A rule that holds now means the finding is fixed, so move it out of `findings.json`.
3. With `--mutants`, it runs each mutant against its rule alone, and the rule must break. A mutant whose rule is a known finding is skipped.

The last line is `Result: ok` or `Result: FAIL`, and the exit code matches.
