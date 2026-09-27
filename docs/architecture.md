# Architecture

pi-plus is a pi package, not a second agent framework. pi owns primary authentication, models, transcripts/tools, compaction, child AgentSessions, and native UI components.

## Layout

```text
src/
  core/                       provider-independent infrastructure
    config.ts, env.ts         configuration and compatibility migrations
    store.ts, file-lease.ts    existing storage facade and cross-process leases
    storage/atomic.ts         strict sync/async atomic replacement mechanics
    exec/                     bounded processes, SSH, shared host configuration
    oauth/                    callback server and PKCE
    errors.ts                 error formatting

  providers/
    index.ts                  explicit native-provider/account composition
    policy.ts, policy-gate.ts  session policy and native request guards
    errors.ts, metadata.ts    provider dispatch and billing metadata
    shared/
      accounts/               account registry, stores, selection, request recovery
      serving.ts              pooled native streams, refresh coordination, attribution
      quota/                  shared snapshots, credential reads, pooling, view types
      builtin.ts              host-supplied pi providers, never deep imports
    anthropic/                auth, accounts, models, quota, serving, usage projections
      remote-control/         Anthropic-specific protocol, token source, provenance
      vendor/                 checksum implementation and license
    codex/                    account-id handling, quota, usage endpoint, error exception
    gemini/                   custom API/auth/models/transport and family quota rules
    openrouter/               ZDR payload enforcement
    kimi.ts, xai.ts            small declarative native-provider adapters
    usage/                    source/presentation composition and legacy display cache

  domains/                    seven pi extension entry points, unchanged load list
    subscriptions/            account/routing commands, picker, footer integration
    models/                   benchmarks and provider-control UI
    workflows/                see below
    agents/                   board client, presence, viewer, configuration and setup
    remote/                   worker configuration, SSH, status, snapshots and jobs
    claude-remote/            consent, session lifecycle and Remote Control UI
    setup/                    setup navigation

  ui/                         provider-independent terminal rendering and settings
server/                       standalone deployable board server
config/skills/                shipped agent skills
```

Small coherent files such as `core/config.ts` remain files; directory depth is not itself a goal. Large providers have a folder rather than a single giant provider file.

## Dependency rules

- `core` imports only core or supplied/declared libraries.
- `providers/shared` imports only shared provider mechanisms, core, or libraries.
- Provider implementations never import extension domains.
- Provider composition modules may select concrete providers explicitly. No plugin framework is needed.
- Domains do not import another domain's internals. Board and worker setup share `core/exec/hosts.ts`.
- Shared terminal renderers accept display data. They have no runtime dependency on providers or domains.
- Runtime source imports must be acyclic. Type-only dependencies are checked separately.

`tests/architecture.test.ts` enforces these rules, verifies extension/source/asset paths, and prevents the removed parallel layouts from returning.

## Providers and quota

Provider-specific endpoints, response interpretation, model-family rules, and account formats belong to their provider. The old mixed-provider `core/quota/usage-source.ts` is gone.

- Anthropic serving and display continue to share the durable, identity-keyed usage cache.
- Codex's usage endpoint is in `codex/usage.ts`, used by both failure checks and display collection. Serving no longer imports a cross-provider display service.
- Gemini API and model-family interpretation remain in its own folder.
- The common rich snapshot schema lives in `shared/quota/snapshot.ts`; Codex does not depend on Anthropic's account store.
- Common freshness/pooling lives in `shared/quota/pool.ts`; Anthropic-specific pool rules live in `anthropic/usage-pool.ts`.
- Provider `usage-view.ts` modules produce plain columns and summaries. The footer renderer does not parse provider names or decide account eligibility.
- Model listing uses the same provider quota projections rather than duplicating family selection inside the tool.
- Codex's access-verification exception is interpreted in `codex/errors.ts`, not independently in workflows and shared request recovery.

The existing credential files, durable quota schemas, polling intervals, leases, account identity rules, and display-cache format are retained. The display cache remains a presentation cache, not a replacement routing database. In particular, `UsageState.accounts` / `geminiAccounts` remain compatibility fields inside `providers/usage`; this change does not introduce a universal new credential/quota store or migrate user files.

Request recovery still owns one fixed bounded budget for the pending request. It does not replay agents, completed tools, or partially exposed output. Native providers retain auth, compatibility flags, models, tools, and caller hooks.

## Workflows

```text
workflows/
  index.ts                    extension lifecycle and command registration
  tool.ts                     workflow tool contract and handlers
  types.ts                    public workflow types
  definitions/                discovery, compilation, invocation parsing and options
  execution/                  engine, concurrency, budgets, usage and finalization
  agents/                     native child sessions, controls and terminal errors
  runs/                       lifecycle, persistence, delivery, queries and progress state
  replay/                     journal, fingerprints and resume validation
  workspace/                  worktrees and diff capture
  advisory/                   shared built-in advisory/research support
  review/                     review reports, action handling and follow-ups
  ui/                         inspectors, widgets, renderers and shortcuts
  builtins/                   code-review, diagnose, perf-review, refactor-scout, research
```

### State ownership

- `WorkflowLifecycle` owns run cancellation/settlement, recovery, and completion delivery.
- `runs/live-runs.ts` owns live progress-source bindings. Tools and UI query the same read-only view; callbacks capture the originating session and cannot repopulate a replacement session.
- `ProgressTracker` owns progress data. `ui/progress-surface.ts` owns the disposable widget/timer; completion clears it before observers run.
- The run store owns retained status/results. The replay journal owns reuse evidence. These are different records, not redundant lifecycle managers.
- `ReviewSessionCoordinator` owns review selection and follow-up budget, not a separate launch/delivery path.

Interactive review follow-ups await `WorkflowLifecycle.runToCompletion()`, which uses the same tracked launch/stop/delivery path as ordinary workflows. Full retained output is attached to a native UI-only entry; parent notifications remain bounded and arrive at native safe boundaries. Legacy visible result messages still render.

Child `/model` and `/thinking` remain child-only. Native transcript/editor/ScrollView behavior remains intact. The old session/control import cycle is broken by `agents/model.ts`.

Source moves legitimately change replay fingerprints. Built-in provenance now covers `src/`, including shared provider/process/storage helpers; moving helpers must not make replay blind to future changes. Old records remain readable; normal source-validation and explicit edited-source-resume rules still apply. Never silently rewrite fingerprints to force replay compatibility.

## Shared infrastructure, explicit policies

`core/exec/bounded-process.ts` is the process implementation. Workflow captures retain strict byte-limit failures. The SSH facade in `exec/process.ts` retains bounded tail capture, streaming output and file stdin. Both now share timeout/cancellation/process-tree cleanup, including Windows termination handling.

`core/storage/atomic.ts` shares temporary-file/rename/cleanup mechanics. It does not decide application durability:

- workflow records throw on failed replacement;
- model-profile writes preserve their domain error;
- Anthropic storage retains bounded Windows rename retries and its existing best-effort exhaustion policy;
- `core/store.ts` explicitly retains its legacy direct-write fallback for compatibility.

Cross-process leases and provider-specific refresh ownership remain separate from atomic file replacement.

## Compatibility and validation

Unchanged: package name/version, seven extension entry points, tool/command names, authentication/storage locations, session-local Remote Control consent, OpenRouter fail-closed ZDR, workflow records, request-recovery timing, bounded telemetry, and published licenses.

Validation includes native SDK/provider fixtures, failure-time quota tests, workflow UI/delivery tests, structural dependency tests, atomic-storage tests, and shared process tests. Use:

```sh
npm run verify
npm pack --dry-run
```

This is an ownership refactor, not a promise to halve the code. After decomposition the source is about the same size, with smaller feature modules and fewer duplicated mechanisms. The [pre-refactor map](repository-map.md) records the original boundaries and findings.
