# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow an odometer scheme: patch rolls into minor at 100, minor
rolls into major at 10.

## [Unreleased]

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

[Unreleased]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.8...HEAD
[1.0.8]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jameslovespancakes/pi-plus/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jameslovespancakes/pi-plus/releases/tag/v1.0.0
