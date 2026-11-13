# Docker Cloud OpenCode verification

Verified 2026-11-10 America/Toronto / 2026-11-11 UTC.

Docker's native OpenCode environment works with a real model Turn through the legacy SDK.
This Docker image supplies OpenCode 1, which Glass runs through its existing agent host.

## Environment

- Docker Sandboxes CLI: `v0.50.1`, build `ddb0268d7124b9cf98955d0b08ffd71a0dfcebe4`.
- Native creation target: `opencode`.
- Resolved image: `docker/sandbox-templates:opencode-docker`.
- Actual OpenCode binary and authenticated health response: **1.19.5**.
- Image's Node runtime: **22.23.4**. Glass's own bundle still requires its Node 24 setup.
- Machine: `linux/amd64`, 1 CPU, 2 GiB, 30-minute TTL, timeout action `delete`.
- Published test server port: 4096, authenticated with a generated HTTP Basic password.
- Client: published `@opencode-ai/sdk` **1.15.13**, imported through its `/v2/client` entry point.
  That export name does not mean OpenCode 2 support.
- Model: **`opencode/big-pickle`**, listed by the live catalog with zero input/output token cost.
  No model API key was configured or copied. Docker cloud compute was still billable.

The SDK was installed in a temporary directory, leaving Glass's manifests and lockfile unchanged.
The exact OpenCode `v1.19.5` source was also fetched with opensrc for protocol inspection.

## Observed results

| Check                 | Result and evidence                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated API     | `/global/health` returned `{healthy: true, version: "1.19.5"}` through Docker's HTTPS port. An unauthenticated loopback request returned 401.     |
| Version distinction   | `/api/info` returned HTML with status 200. A successful HTTP status alone must not identify OpenCode 2.                                           |
| Real Turn             | `session.promptAsync` produced streamed output and the exact answer `GLASS_OPENCODE_OK`, followed by `session.idle`.                              |
| Native tool execution | The bash tool ran `printf GLASS_TOOL_OK`; message history contained the completed tool output.                                                    |
| Active Steer          | While a filesystem-gated bash tool was running, a second async prompt changed the requested response. Releasing the gate produced `STEERED_OK`.   |
| Stop during a tool    | `session.abort` returned true; the assistant message reported `MessageAbortedError`, and the session became idle.                                 |
| Turn after Stop       | The same session subsequently answered `AFTER_STOP_OK`.                                                                                           |
| Tool cleanup          | A `/proc` check found no lingering Node process for the stopped filesystem gate.                                                                  |
| Client reconnect      | A separate client loaded the same native session ID and its 13 messages.                                                                          |
| Server restart        | The owned OpenCode server was terminated and relaunched. Its PID changed from 691 to 841; the same session and all 13 message IDs were preserved. |
| Context after restart | Asked for the token from its first request, the resumed conversation answered `GLASS_OPENCODE_OK`.                                                |
| Machine deletion      | `sbx --cloud rm --force` completed. A subsequent inspect returned `sandbox 'sbx_001m74a2vex8v41kr4ckc3affyd' not found`.                          |

The gates used filesystem notifications, not sleeps, to hold the tool open. The controller sent
the Steer or Stop only after observing a native running-tool event. The event consumer was active
before sending each prompt. Startup after restart waited for the server's listening output through
a filesystem notification on its log.

The temporary machine was `glass-opencode-verify-7d61`, ID
`sbx_001m74a2vex8v41kr4ckc3affyd`, created at `2026-11-11T03:23:27.129746Z`. It is gone.

## Implications for the Glass adapter

1. Start with the verified V1 native API and a pinned legacy SDK. The tested pairing is SDK
   1.15.13 with CLI 1.19.5; this does not prove every combination or future Docker image.
2. Detect and validate the actual version. Check JSON shape and content type when probing health;
   an HTML 200 response must not pass as another generation's API.
3. Subscribe and begin consuming before sending work. The SDK returns a lazy async event stream;
   waiting for `server.connected` proved the subscription was active in this probe.
4. Preserve the native session ID. Reconnecting and restarting can retain the same conversation;
   creating a new session for each Glass Turn would throw that behavior away.
5. Model Steer admission and consumption separately. This check proves an active prompt can take
   a second message, but does not prove every race involving a Steer and Stop. Return input that
   OpenCode did not consume, as Glass's existing adapters do.
6. Use the native cancellation outcome to classify Stop. In this run the assistant had
   `MessageAbortedError` while the tool's stored status was `completed`. Tool status alone is not a
   reliable Turn ending.
7. Do not require Anthropic credentials for every OpenCode Sandbox. The tested model worked with
   an empty cloud secret store. GitHub credentials are still needed for private clones and pushes.
8. Do not treat a provider's appearance in `connected` as proof of usable credentials. The catalog
   reported several providers connected despite the empty cloud secret store; only the selected
   OpenCode model was exercised.

## Limits and retained evidence

This verified the real Docker image, native server, SDK, and model. It did not run through Glass's
UI or an OpenCode `AgentAdapter`, which does not exist yet. Permission approval, structured
Questions, image attachments, model/effort switching, Skill packs, private repository credentials,
and a stream lost while a Turn completes remain unverified. Server restart was tested between
Turns, not during one. Basic Turns passing on the smallest machine is not a build-workload
capacity or performance claim.

The verification scripts and raw SSE events are retained locally under
`.verify/opencode-cloud/` (ignored by git). They are investigative probes, not the finished
ADR 0011 session recording harness. The sanitized result summary is retained in
[`evidence/docker-opencode-verification.json`](evidence/docker-opencode-verification.json).
The generated server password and temporary connection/config files were removed after cleanup.

Next implementation checks: add real-program recordings at Glass's adapter seam, cover the
remaining lifecycle races and request flows, run the focused server tests and `pnpm check`, and
verify create/message/reconnect/remove through Glass itself. No application source was changed
by this verification.
