# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow an odometer scheme: patch rolls into minor at 100, minor
rolls into major at 10.

## [Unreleased]

## [1.0.16] - 2026-09-22

### Added

- `gemini` provider for subscription Gemini on a Google account (pi keeps only
  the metered `google` API), served by Google's Antigravity backend and ported
  from [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity) 0.8.0
  (MIT; notice in `src/core/gemini/LICENSE.md`). It appears in `/login` and
  `/accounts` and joins the shared OAuth pool. Serves Gemini 3.x Flash and
  3.1 Pro plus the Claude and GPT-OSS models the backend offers, with each
  thinking level routed to its runtime model. The catalogue refreshes live from the account (4h
  freshness window; `/models-refresh` forces it). Message conversion, retry
  policy and error formatting stay pi's; the envelope, endpoint fallback,
  Claude/GPT-OSS tool-schema bridge, conversation repairs, stall watchdog and
  quota-wall handling are implemented here. A quota-walled account is held out
  of routing until its reset.
- `/models-refresh` also force-refreshes pi's live model catalogues.
- Pooled `/accounts` sign-ins dismiss the paste prompt once the browser
  callback arrives.
- `PooledOAuthProviderSpec.identityOfCredential` for providers whose access
  tokens are opaque, and `accessTokenOf` so quota can be attributed when
  `toAuth()` encodes more than the token into `apiKey`.

- Live Anthropic model discovery. pi's catalogue is generated at build time,
  so a newly shipped model stayed invisible until pi was upgraded —
  `claude-opus-5-5` was usable for days while the picker denied it existed.
  The list is now read from `/v1/models`, cached for a day, and merged over
  pi's catalogue; a discovered model inherits limits and pricing from the
  newest model of its family. `/models-refresh` re-asks on demand.

### Fixed

- Anthropic requests substituted pi's beta list instead of merging with it,
  dropping the model-specific betas that authorise fields pi itself emits.
  Every Opus 5 request failed with `messages.1.output_config: Extra inputs are
  not permitted`. The Claude Code identity no longer sets `anthropic-beta`
  (pi copies that header verbatim into the body) and unions the two lists per
  request instead.
- The Anthropic catalogue replaced pi's rather than extending it, so
  `claude-opus-4-6`, `claude-opus-4-7`, `claude-sonnet-4-6` and the dated
  aliases silently disappeared from the picker.
- Claude Code identity version raised to 2.1.280; Anthropic rejects Opus 5.5
  below it.
- The shared OAuth pool aliased a module-level empty-file constant when the
  accounts file did not exist, so every later write accumulated in it and
  outlived both the cache and the file.

## [1.0.15] - 2026-09-21

### Changed

- Require pi 0.87.0 or newer for compatible provider module resolution.

## [1.0.14] - 2026-09-21

### Changed

- Removed automatic remote-capacity and agent-board snapshot injection from
  ordinary turns. Remote capacity and board state are now fetched only through
  their explicit tools, so neither feature delays or grows normal chat context.

### Removed

- Removed Better Compact, its recall tool, and its parallel context-management
  configuration. Pi once again owns compaction, context thresholds, transcript
  handling, and token accounting without extension-side intervention.

### Fixed

- Temporary Codex access-verification failures now identify the model that was
  actually selected, explicitly state that no alternate model was requested,
  and are classified as retryable when a workflow opts into agent retries.
- Aligned the local Pi peer packages with the host's 0.86.1 compatibility
  metadata so provider wrapping preserves mid-conversation system messages and
  Codex requests retain their declared tools.

## [1.0.13] - 2026-09-20

### Added

- Better Compact, a reversible compaction mode with trust-aware chunking,
  content-addressed checkpoints, an append-only local source archive, extractive
  compression, and optional Jev routing through OpenRouter's decisions API.
- `super_context_recall` for bounded exact retrieval from the current archived
  checkpoint.
- Stable Anthropic account identity discovery and regression coverage for
  rotating-token refresh, duplicate accounts, archive safety, and workflow UI
  theming.

### Changed

- The workflow inspector now uses Pi's active theme for chat, Markdown, tool,
  selection, input, and border styling, preserves multiline messages, and opens
  as a smaller 70% modal.
- `/compact better` modes now appear in argument autocomplete, and enabled modes
  use a themed green `Better Compact` footer status instead of an internal label.
- `/accounts` includes Pi's primary credential, prevents it from being toggled
  or renamed, and collapses sidecar logins that resolve to the same provider
  identity.
- Agent-board context snapshots are compact, stable turn-boundary messages;
  live deliveries are batched instead of repeatedly injecting volatile prompt
  and tool arguments.
- TypeScript is pinned for reproducible checks and the project config no longer
  contains machine-specific module-resolution paths.

### Fixed

- Anthropic sidecar credentials now refresh independently of quota polling,
  rotate under in-process and cross-process locks, use bounded requests, and
  cannot be overwritten by a stale quota snapshot. Expired sidecars are no
  longer routed while refresh catches up.
- Codex pooled routing now uses atomic, change-gated persistence, preserves rich
  quota snapshots, bounds OAuth refreshes, and avoids serializing infinite
  account blocks.
- Failed isolated workflow runs retain recoverable worktrees and report their
  paths instead of deleting unfinished edits. Retry failures now preserve both
  the original provider error and any final agent-limit error.
- Workflow run records retain per-agent failure details, and the subscription
  footer no longer shows the noisy `partial` title suffix.

## [1.0.12] - 2026-09-19

### Added

- Multi-account OAuth pools for Kimi Code and xAI/Grok, with duplicate checks,
  refresh handling, account labels, enable controls, and sequential or
  quota-aware routing.
- An embedded workflow engine with background runs, replay, worktree isolation,
  progress and usage reporting, plus five built-in workflows.
- A clickable workflow agent board with per-agent activity, chat logs, and targeted follow-ups.

### Changed

- Releases require an explicit `--release` commit marker or manual `--release` confirmation.
  Release notes now include every commit since the previous release, and version bumps keep
  the package lock synchronized.
- Workflow and OAuth account storage now ship directly in pi-plus instead of
  external pi packages.
- `/workflow` opens the currently running workflow as a modal agent board.
  Named workflows still run with `/workflow <name>`, and run limits are opt-in.
- Account routing now uses the same sequential and quota-aware modes across
  Claude, Codex, Kimi, and Grok; Codex credentials are routed per request.
- Account lists load providers in parallel, model-quality lookups are cached,
  and footer usage totals are reused until the session changes.
- Shared JSON writes create parent directories and clean up temporary files.
- CI steps and comments use shorter, consistent names.
- The package description is now "pi and more".

### Fixed

- Anthropic request rewriting now ignores non-Anthropic provider payloads.

## [1.0.11] - 2026-09-19

### Changed

- The example config and its test use placeholder worker names. The previous
  ones were real hosts from the author's machine, which mattered once the
  repository became public.

### Added

- `.env` files are git-ignored.

## [1.0.10] - 2026-09-19

### Fixed

- The GitHub Packages mirror failed with `ENEEDAUTH`. `setup-node` only
  authenticates the default registry, so `NODE_AUTH_TOKEN` alone does not
  cover a second one; the scope and token are now bound to that host
  explicitly.

## [1.0.9] - 2026-09-19

### Added

- npm provenance. Each release is signed with the commit and workflow that
  built it, so npm shows a verified link back to this repository. This needs a
  public repository, which is why it was not possible before.
- A mirror of each release on GitHub Packages, so the repository lists a linked
  package. npmjs.com remains the install path: GitHub Packages requires a token
  even for public packages.

## [1.0.8] - 2026-09-19

### Fixed

- `EPERM: operation not permitted, rename` when saving Anthropic credentials
  on Windows. The store writes a temp file and renames it over the target, and
  Windows rejects that rename whenever another handle holds the destination
  open, which is what a virus scanner, the search indexer or a second pi
  session looks like. The rename is now retried briefly, and a write that
  still cannot land is dropped instead of throwing into a live request.
- Write amplification that made the collision likely in the first place. Quota
  headers arrive on every response and routing recorded `lastUsed` on every
  request, so a single API call rewrote two credential files twice. Quota is
  now persisted only when a percentage actually changes, and `lastUsed` at most
  once a minute, taking a normal request from four writes to none.

## [1.0.7] - 2026-09-19

### Removed

- The published package no longer carries the changelog, the project mark, the
  example config or internal provenance notes. It ships source, the board
  server, the skill, the README and the licences, and nothing else.
- `src/vendor/anthropic.ts`, a shim for the package that was removed when the
  Anthropic provider was reimplemented here. Nothing had imported it since.

## [1.0.6] - 2026-09-19

### Fixed

- The build badge reads the release workflow instead of the CI workflow. A
  `workflow_call` run is attributed to the caller, so CI had no runs of its own
  on main and its badge showed "no status". The release workflow contains the
  same lint, typecheck and test job, so the badge cannot be green unless those
  passed.

## [1.0.5] - 2026-09-19

### Changed

- The README shows each interface as text rather than a screenshot. The blocks
  are generated from the real renderers with dummy data, so they cannot drift
  from the code the way the screenshots had, and they stay readable in a
  terminal, a diff and on npm.

### Removed

- The five demo screenshots. Only the project mark remains, which takes the
  published package from 489KB to 375KB.


## [1.0.4] - 2026-09-19

### Changed

- The README leads with the mark alone instead of repeating the name beneath
  it, and credits the Anthropic provider correctly: it was adopted from
  `@cortexkit/pi-anthropic-auth` and has since been reimplemented here.

### Added

- A disclaimer covering provider terms of service.

## [1.0.3] - 2026-09-19

### Added

- A `CHANGELOG.md`, and GitHub releases whose notes are generated from it.
  `scripts/changelog.mjs --promote` retitles `## [Unreleased]` as the new
  version at release time, so entries are written without needing to know the
  next version number.

## [1.0.2] - 2026-09-19

### Fixed

- Release tags now reach the remote. `git tag` creates a lightweight tag and
  `git push --follow-tags` pushes only annotated ones, so every tag was
  silently dropped while the job still reported success.
- The release job name no longer renders twice. GitHub prefixes a reusable
  workflow's job name with the caller's, so naming both produced
  `Lint / Typecheck / Tests / Lint / Typecheck / Tests`.

## [1.0.1] - 2026-09-19

### Added

- Releases are gated on lint, typecheck and tests as a separate job.
  Publishing cannot begin unless every check passes, rather than relying on
  step ordering inside one job.

### Changed

- CI and release run on Node 24, which ships the npm 11.5.1+ required for
  trusted publishing.
- `actions/checkout` and `actions/setup-node` upgraded to v5; v4 targets the
  deprecated Node 20 runtime.

## [1.0.0] - 2026-09-19

First published release.

### Added

- **Subscription accounts.** Multiple Anthropic and Codex subscriptions in one
  pool, with quota-aware routing. `/accounts` lists every provider's accounts
  and toggles them in place; `/accounts add` and `/accounts rename` run as
  wizards.
- **Codex multi-account.** PKCE OAuth, per-account quota from `x-codex-*`
  response headers, and duplicate detection by ChatGPT account id so two
  entries cannot share one quota pool.
- **Quota from response headers.** Anthropic reports utilisation on every
  reply, so the account serving traffic refreshes at no request cost. Idle
  accounts are polled at most once per 10 minutes, triggered by sending a
  message rather than a timer.
- **Usage HUD.** Pooled 5h, weekly and per-model tiers for Claude, and 5h and
  weekly for Codex, served from cached snapshots.
- **Model catalogue and billing policy.** `/models`, `/model-info` and
  `/provider` with benchmark-driven selection and an approval gate.
- **Agent board.** `/board` for live cross-agent messaging.
- **Remote workers.** `/remote` for capacity-gated test and build workers.
- **Own the Anthropic provider.** OAuth, routing, quota and client identity
  are implemented in this repository rather than pulled from a dependency.

### Fixed

- The account list and `/usage` both returned empty because they still
  imported a package that had been removed during the provider extraction.
  The failure was swallowed, so it looked like "no accounts" rather than an
  error.
- Cached usage rows omitted `checkedAt`, so freshness checks discarded every
  one and the HUD read `unknown/stale` with no bars.
- The provider picker redrew the whole screen on each toggle. It now updates
  in place inside pi's own inline chrome.
- Scoped per-model limits were labelled from Anthropic's internal id, which
  truncated to `claude` and named neither the window nor the model. They now
  show the model family, for example `Fable`.

[Unreleased]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.16...HEAD
[1.0.16]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jameslovespancakes/pi-plus/releases/tag/v1.0.0
