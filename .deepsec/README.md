# deepsec

The [deepsec](https://www.npmjs.com/package/deepsec) security scanner's workspace for Glass.
`data/glass/INFO.md` is the context deepsec gives the model with every batch: Glass's auth shape,
threat model, and known false positives. Keep it under 100 lines and update it when one of those
changes. Scan output is gitignored.

## Running a scan

From this folder, after `pnpm install`:

```bash
pnpm deepsec scan                                    # regex candidates, free
pnpm deepsec process --concurrency 5 --model-auth local \
  --filter apps/server/src --skip-slugs insecure-crypto,missing-await
pnpm deepsec export --format md-dir --out ./findings
```

- `process` is the AI stage, and it runs Opus 5.5 at high thinking (`deepsec.config.ts`).
  `--model-auth local` uses your `claude` login. It has no cost cap, so bound it with `--filter` or
  `--limit`.
- `insecure-crypto` and `missing-await` are almost all noise here: `DESC` in SQL and `yield*` in
  `Effect.gen`. Skipping them took the AI stage from 306 files to 121.
- To re-check only what changed, pass `--files-from <list>` or `--diff <ref>`. In that mode
  `process` exits 1 when it finds anything.
