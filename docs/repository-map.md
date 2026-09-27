# pi-plus pre-refactor repository map

Historical audit snapshot. For the implemented structure, see [architecture.md](architecture.md).

Snapshot: working tree at package version **1.0.24**, including the unreleased request-recovery and workflow UI changes. This is an architecture map, not a claim of a line-by-line security audit.

Scope: inventory and static import/export analysis of all **166 TypeScript files under `src/`**, plus implementation review of the provider/request/quota, workflow/lifecycle, UI, board, remote-worker, configuration, packaging, and release boundaries. Static edges include literal dynamic imports; runtime-cycle analysis excludes type-only imports. Vendor code and the standalone board server are outside the TypeScript counts.

## 1. Size and entry points

| Current location | TS files | Lines | Responsibility |
|---|---:|---:|---|
| `src/core/` | 41 | 7,099 | Infrastructure, provider implementations, account routing/recovery, quota, benchmark cache, policy, Remote Control protocol |
| `src/domains/subscriptions/` | 13 | 2,014 | Account commands/picker, native provider registration, pooled serving, footer |
| `src/domains/models/` | 4 | 751 | Benchmark tools, provider approval/ZDR, picker |
| `src/domains/workflows/` | 94 | 17,187 | Workflow loading/execution, child sessions, replay, worktrees, results, inspection, built-ins |
| `src/domains/agents/` | 3 | 899 | Board transport, presence, messaging UI/tools, server setup |
| `src/domains/remote/` | 3 | 1,293 | SSH worker setup, capacity checks, snapshots, admission, remote jobs |
| `src/domains/claude-remote/` | 3 | 260 | Session-local Remote Control lifecycle, auth bridge, picker |
| `src/domains/setup/` | 1 | 230 | `/pi-plus` status and setup navigation |
| `src/services/` | 1 | 178 | Shared usage polling and display cache |
| `src/ui/` | 3 | 345 | Usage bars, formatting, settings frame |
| **Total** | **166** | **30,256** | Excludes tests, JS vendor code, server, documentation |

`package.json → pi.extensions` loads these seven entry points, in order:

1. `src/domains/setup/index.ts`
2. `src/domains/subscriptions/index.ts`
3. `src/domains/models/index.ts`
4. `src/domains/workflows/index.ts`
5. `src/domains/agents/index.ts`
6. `src/domains/remote/index.ts`
7. `src/domains/claude-remote/index.ts`

These are pi extensions, not independent applications. pi owns the model registry, primary authentication, transcript/tools, agent sessions, compaction, and native UI lifecycle.

## 2. Provider and subscription map

### Current provider homes

| Provider | Protocol/auth/storage | Registration/account adapter | Other places containing its rules |
|---|---|---|---|
| Anthropic | `core/anthropic/` | `subscriptions/provider.ts`, `subscriptions/providers/anthropic.ts`, `anthropic-serving.ts` | `core/quota/usage-source.ts`, `core/quota/pool.ts`, usage service, bars, model catalog tool |
| Codex | `core/codex/` | `subscriptions/providers/codex.ts` | `core/quota/usage-source.ts`, bars, catalog tool, workflow error translation |
| Gemini | `core/gemini/` | `subscriptions/providers/gemini.ts` | `core/quota/usage-source.ts`, bars, catalog tool |
| Kimi / xAI | pi's built-in providers | `subscriptions/providers/hosted.ts` | `core/quota/pool.ts` observed-provider list, catalog billing classification |
| OpenRouter | pi's built-in provider plus `core/policy/openrouter.ts` | `models/policy-gate.ts` | Generic policy state and provider picker contain OpenRouter-specific modes |

### Shared pieces today

- `core/accounts/registry.ts`: account-management interface and registry.
- `core/accounts/oauth-pool.ts`: common sidecar account storage and primary quota state.
- `core/accounts/routing.ts`: candidate selection, generic headers, multiwindow quota reduction.
- `core/accounts/request-recovery.ts`: same-request recovery and partial-output/cancellation safety.
- `core/accounts/provider-errors.ts`: limit classification and reset parsing.
- `subscriptions/providers/oauth-pool.ts`: account CRUD, refresh coordination, credential selection, native provider wrapping, response attribution, and failure-time usage checks.
- `core/oauth/`: PKCE and callback-server primitives.
- `core/quota/usage-source.ts`: provider-specific usage endpoints, credential access, row conversion, and aggregation.
- `services/usage-service.ts`: display refresh scheduling, cache persistence, retention, and subscribers.

### Main flows

```text
pi-owned primary credential + extra account store
    → shared candidate selection / sidecar refresh
    → shared recovery around native provider stream
    → exact serving credential + unchanged model/context/tools
    → response observation / optional non-inference usage recheck
    → quota state used by subsequent selection
```

```text
footer / usage command / model information
    → usage-service
    → usage-source
    → provider APIs/caches
    → UsageRow[] display cache
    → bars or model quota summaries
```

Those are related flows, but they do not yet have one quota ownership boundary. In particular, Codex's serving adapter now calls the display-oriented `fetchCodexRows()` to reuse its endpoint rather than duplicate HTTP code. That is a useful reuse but an inverted dependency to remove during the refactor.

### Provider-local complexity that is intentional

- Anthropic: subscription identity/signing, OAuth, live-model additions, account identity aliases, coordinated refresh, durable quota/cooldown cache.
- Gemini: custom provider transport, conversion, request repair, schemas, model discovery, project credentials, interactive verification. pi does not supply this Antigravity implementation.
- Codex: account-id/token consistency and preservation of its existing rich account store.
- OpenRouter: ZDR payload enforcement and specific unavailable-route translation, retaining native auth/tools/compatibility.

## 3. Workflow map

Workflows account for approximately **57% of `src/`**. Most of that is real feature and safety code; provider cleanup alone will not halve the repository.

All paths below are relative to `src/domains/workflows/`.

| Area | Current modules |
|---|---|
| Extension surface | `index.ts`: commands, tool schema, invocation parsing, lifecycle wiring, active-inspector map, rendering, review follow-ups |
| Definition loading | `runtime/discovery.ts`, `inline-workflow.ts`, `workflow-module.ts`, `workflows.ts` |
| Public API/configuration | `runtime/types.ts`, `options.ts`, `model-profiles.ts`, `command-completions.ts`, `pi-compat.ts` |
| Execution | `runtime/engine.ts`, `workflow-execution.ts`, `concurrency.ts`, `agent-limits.ts`, `budget.ts`, `cancellation.ts`, `finalizers.ts` |
| Child agent | `runtime/agent-runner.ts`, `agent-attempt.ts`, `agent-runner-types.ts`, `agent-session.ts`, `agent-session-providers.ts`, `agent-options.ts`, `agent-skills.ts`, `agent-workspace.ts`, `live-agent.ts`, `structured-output.ts`, `tool-capabilities.ts` |
| Request failure → run outcome | `runtime/agent-retry.ts`, `provider-usage-limit.ts`, `workflow-usage-limit-scheduler.ts`; pending-request retries themselves live in `core/accounts/request-recovery.ts` |
| Live progress/accounting | `runtime/progress.ts`, `progress-types.ts`, `usage.ts`, `perf.ts` |
| Run lifecycle and persistence | `runtime/workflow-lifecycle.ts`, `workflow-run-controller.ts`, `workflow-run-record.ts`, `workflow-run-store.ts`, `workflow-run-delivery.ts`, `workflow-run-history.ts`, `workflow-management.ts` |
| Replay and provenance | `runtime/agent-replay.ts`, `journal.ts`, `resume-context.ts`, `agent-session-identity.ts`, `tool-source-identity.ts`, `tree-fingerprint.ts`, `identity-fingerprint.ts`, `identity-canonicalization.ts`, `replay-path-identity.ts` |
| Workspace/process support | `runtime/worktree.ts`, `process-runner.ts`, `diff-capture.ts`, `review-diff-target.ts`, `filesystem-error.ts`, `unknown-error.ts`, `debug.ts`, `session-identity.ts` |
| General workflow UI | `runtime/ui/`: native transcript adapter, inspector, widget, result formatting/rendering, layout, display sanitization, editor decoration |
| Dynamax activation | `runtime/dynamax.ts`, `dynamax-shortcuts.ts` |
| Advisory workflow support | `runtime/advisory-schema.ts`, `advisory-evidence.ts`, `advisory-challenge.ts`, `workflow-advisory-utils.ts` |
| Research support | `runtime/research-contract.ts`, `research-evidence.ts` |
| Review feature | `runtime/review/`: report/issues, diff snapshot, result viewer, action handling, patch validation, follow-up fixes, comments, handoff, budget, session coordinator |
| Built-in programs | `workflows/{code-review,diagnose,perf-review,refactor-scout,research}.ts` |

### Execution and presentation flow

```text
command or workflow tool
    → resolve/compile definition + normalize options
    → WorkflowLifecycle.launch (immediate durable run ID)
    → executeWorkflowInvocation
    → engine
        → child pi AgentSession
        → replay / workspace / concurrency / budget
        → ProgressTracker and native usage aggregation
        → durable run record and replay journal
    → lifecycle completion
        → immediate UI-only receipt
        → bounded parent notification at a native safe boundary
```

The code-review action path additionally calls `executeResolvedWorkflow()` directly and publishes through `sendWorkflowExecution()`. It is not the same completion path as a normal lifecycle launch.

### State owners today

- `WorkflowLifecycle.active`: run cancellation and settlement handles.
- `index.ts` inspector map: currently attached live sources.
- `ProgressTracker`: rows, counts, transcript bindings, control bindings, breadcrumbs, widget lifecycle.
- Durable run record: retained status, outcome, usage, origin/delivery metadata.
- Replay journal: reusable completed-call results and evidence.
- `ReviewSessionCoordinator`: retained review report and follow-up budget.

These are not all duplicates. Live handles, durable records, review-specific state, and replay evidence serve different purposes. The cleanup opportunity is to give each one a single owner and expose queries instead of having callers coordinate multiple maps themselves.

### Verified static dependency issue

There is one runtime import cycle in the `src/**/*.ts` graph:

```text
runtime/agent-session.ts → runtime/live-agent.ts → runtime/agent-session.ts
```

`live-agent.ts` imports `resolveAgentModel()` back from session construction. Moving that resolver to the existing model-resolution layer breaks the cycle without adding a framework.

### Unwired/legacy candidates, not blanket deletion targets

- `WorkflowRunController.handleCommand()`, `inspectStoredRun()`, and its completion methods have no call sites in current `src/`; lifecycle/scheduler methods on the same class **are** used.
- `ReviewSessionCoordinator.present()` is not called by the current entry point; `remember()` and `reopen()` are used.
- Anthropic `selectAccount()` is exercised by tests but has no current production caller; serving uses the shared selector.
- `registerCodexProvider()` has no current source caller; registration happens in the subscriptions entry point.
- `agent-retry.ts` no longer retries agents: its remaining job is terminal error reconstruction.

Confirm external compatibility and intended retained-history UI before removing these. Unwired UI methods are not permission to remove persisted history or resume support.

## 4. Collaboration and remote execution

### Messaging board

- `domains/agents/index.ts`: configuration fallback, Git presence, WebSocket RPC/reconnect, board UI, native event delivery, tool registration.
- `domains/agents/board-setup.ts`: local process lifecycle, remote installation/service scripts, health/admin commands.
- `domains/agents/format.ts`: bounded delivery formatting.
- `server/board-server.mjs`: standalone HTTP/WebSocket server, SQLite persistence, rooms, presence, coordination, request authorization and retention.

The board server is intentionally deployable as one file. `board-setup.ts` embeds that file into its remote installation script. Splitting it requires changing deployment, not merely moving functions.

### Remote workers

- `domains/remote/index.ts`: worker validation, health probing, selection, snapshot/path safety, archive consistency checks, admission slots, upload/run/cleanup scripts, tools.
- `domains/remote/setup.ts`: SSH/key onboarding and worker picker.
- `domains/remote/config-path.ts`: feature-specific config view.
- `core/exec/`: shared SSH configuration parsing and process execution.

Board setup imports `domains/remote/config-path.ts` directly to offer known hosts. This is the concrete cross-domain dependency to replace with a shared SSH/configuration view.

### Claude Remote Control

- `domains/claude-remote/index.ts`: explicit consent, session epoch/generation, inbound prompts, cancellation, completed-message mirroring.
- `domains/claude-remote/auth.ts`: primary pi OAuth token source.
- `domains/claude-remote/picker.ts`: session-local toggle.
- `core/claude-remote/{bridge,protocol}.ts`: Anthropic wire protocol, queues, reconnection and serialization.

Do not merge this transport with board RPC or SSH jobs. They have different security and lifecycle semantics.

## 5. Infrastructure, configuration, and release

- `core/store.ts`, `file-lease.ts`: filesystem persistence primitives and cross-process leases.
- `core/config.ts`, `env.ts`: pi-plus configuration, compatibility migrations, environment precedence.
- `core/catalog/quality.ts`: Artificial Analysis cache, matching, scores, pricing/efficiency.
- `core/policy/`: session policy plus OpenRouter-specific payload logic.
- `ui/`: shared formatting/settings primitives mixed with provider-aware usage presentation.
- `config/skills/`: shipped model-routing and review-action skills.
- `config/pi/` and `config/pi-plus.example.json`: reference configuration; not all config files are published.
- `tests/*.test.ts`: node:test suites; `tests/fixtures/` contains simulated transports and native SDK integration children.
- `tests/packaging.test.ts`: pi-supplied import allowlist and peer-dependency contract.
- `.github/workflows/ci.yml`: Node 24 lint/typecheck/tests and package-content checks.
- `.github/workflows/release.yml`, `scripts/{bump-version,changelog}.mjs`: explicit `--release` gate, version/changelog promotion, publication and tags.
- `AGENTS.md`: ownership and safety rules. Its illustrative `bench/` directory is not present in this checkout.

## 6. Refactoring hotspots

| Boundary | Evidence | Direction |
|---|---|---|
| Quota ownership | Routing state, provider cache, `UsageRow` cache, UI availability and catalog quota selection | One observation owner; routing and UI become projections |
| Provider locality | Provider rules span `core/`, subscriptions, usage source, models, UI | One provider home plus shared serving/quota infrastructure |
| Provider-independent errors | Codex-specific recognition appears in shared recovery and workflow errors | Adapter-specific extraction → shared typed failure |
| Extension entry points | Remote 829 lines; workflows 775; board 451 | Registration-only entry points with feature-local implementations |
| Process execution | `core/exec/process.ts` and workflow `process-runner.ts` | Reuse native pi where sufficient; otherwise one low-level implementation with explicit capture/termination policies |
| Persistence | Common writer, Anthropic writer, workflow record writer, model-profile writer | Shared atomic-write mechanics; keep durability/error/credential policies explicit |
| Workflow state/presentation | Progress tracks state and renders widgets; main and review completion paths differ | One runtime owner, one completion delivery path, UI subscribers |
| Runtime cycle | Session ↔ child input controls | Move model resolution out of session construction |

## 7. Verified implementation baseline

Before writing this map:

- `npm run lint`: clean.
- `npm run typecheck`: passed.
- `npm test`: **428 tests, 427 passed, 0 failed, 1 skipped**.
- `git diff --check`: passed (Git also reported CRLF normalization advice).
- Local pi-ai / pi-coding-agent and installed host: **0.87.1**.
- Recovery tests use simulated failures/transports, including native provider and AgentSession paths.

No release, installation, credential-store migration, or architectural refactor was performed.

See [the implemented architecture](architecture.md) for current paths, ownership rules, and compatibility boundaries.
