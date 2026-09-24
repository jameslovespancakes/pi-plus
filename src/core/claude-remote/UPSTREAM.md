# Claude Remote protocol provenance

Protocol reference:
- [clepdn/claude-remote-lib](https://github.com/clepdn/claude-remote-lib),
  commit `8ee032b3e6907f7ca34bff0a5d508d03db63d2fe` (v0.2.0).
  Its package.json declares MIT. Attribution/license: [LICENSE.md](LICENSE.md).
- [clepdn/pi-claude-remote](https://github.com/clepdn/pi-claude-remote),
  commit `0602c78af0e1adfad8a20a90bf080c59643735fb` (v0.1.0).
  Used as a behavior reference for the independently implemented pi adapter.
  That repository does not declare a license; its source is not vendored.

Only the required CCR v2 protocol is implemented here: create session, bridge
credentials, worker registration via PUT, SSE input, batched event output,
heartbeats, delivery ACKs, state, control replies, and worker credential refresh.
No npm/git runtime dependency on either upstream, generated dist, examples,
probes, SDK convenience API, or copied pi message definitions are shipped.

Differences from the upstream implementations:
- Explicit opt-in; no uploads just because pi-plus is installed.
- pi's current ModelRuntime owns auth.json and locked OAuth refresh; no direct
  credential parsing, copied OAuth flow, sidecar credential store, or inference
  account rotation. Upstream's AuthStorage.getApiKey API is no longer public.
- Startup resolves on SSE headers, not stream EOF, so heartbeat/refresh run.
- One bounded writer batches events and serializes worker epoch changes.
  Writes retry at most three times; reconnect attempts are bounded. Requests
  have timeouts and cancellation; stop invalidates late callbacks and startup.
- Queues/dedup/frame sizes are bounded. Overload stops mirroring with a local
  warning rather than growing forever or blocking the local agent.
- Network work never runs on pi's message dispatch path.
- Complete messages only, avoiding per-token traffic and a second accumulator.
- Uses pi's AgentMessage types; no transcript/context rewriting.
- Static session titles, no hidden Haiku inference or session-title API calls.
- Read-only also disables remote interruption; unsupported model/permission
  changes return errors instead of falsely acknowledging a local change.
- No historical replay or persistence of remote credentials/session handles.
  Each local session/branch connection starts a fresh remote mirror.

The worker URL is an API endpoint, not a browser link. Users open
https://claude.ai/code and select the named pi session, as upstream's live
probe instructs. This is an unofficial protocol and may change without notice.
