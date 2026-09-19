<div align="center">

<img src="images/pi-plus.svg" alt="pi-plus" width="160">

**Everything [pi](https://pi.dev/) is missing, in one install.**

[![npm](https://img.shields.io/npm/v/@jameslovespancakes/pi-plus?color=%234D9ABF&label=npm)](https://www.npmjs.com/package/@jameslovespancakes/pi-plus)
[![CI](https://github.com/jameslovespancakes/pi-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/jameslovespancakes/pi-plus/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-F1BE58)](LICENSE)
[![pi-package](https://img.shields.io/badge/pi--package-F09082)](https://pi.dev/packages)

[Changelog](CHANGELOG.md) · [Releases](https://github.com/jameslovespancakes/pi-plus/releases)

</div>

---

## Install

```sh
pi install npm:@jameslovespancakes/pi-plus           # npm
pi install git:github.com/jameslovespancakes/pi-plus # git
pi install /path/to/pi-plus                          # local checkout
```

Then run **`/pi-plus`**. It shows what is configured and what is not, and enter
on any row starts that setup.

```
──────────────────────────────────────────────────────────
 pi-plus
› ● Subscriptions   2 accounts · optimal
  ● Model Information  catalogue cached
  ● Providers       2 allowed · 4 need approval
  ● Agent Board     not configured
  ● Remote Workers  1 worker

  Enter to set up · Esc to close
──────────────────────────────────────────────────────────
```

`/pi-plus help` asks the model to explain the pack and what you are missing.
Nothing else is required, every feature configures itself from within pi.

---

## Features

### Pool every subscription

Add all the Claude accounts you own. pi-plus balances sessions across them by
**remaining quota and time-to-reset**, keeps caches sticky, and migrates only on
confirmed exhaustion.

```
/account anthropic add work
/routing optimal
```

Your live quota, always in the footer:

```
  Claude Σ2 · 2/2 ready · partial                 Codex · pro
  5h     █████████████████░░░░░░░░░   65% 1h     5h     ███████████████████████░░░   88% 57m
  weekly ███████████████░░░░░░░░░░░   58% 3d     weekly ████████████████████████░░   93% 6d
  Fable  ████████████░░░░░░░░░░░░░░  ~47% 3d
  Work 72% · Personal 58%
```

With more than two accounts only the two most recently used are listed, so the
footer stays a fixed height however many you pool.

Account and routing commands are provider-agnostic: they dispatch through an
adapter registry, so a second provider is one adapter, not a new command
surface. Anthropic ships today.

### Pick models on evidence

`list_models` puts the full **Artificial Analysis** benchmark set in front of the
agent: intelligence, coding, Terminal-Bench, τ²-bench, GPQA, price, tok/s and
score-per-dollar, *plus your remaining quota*.

```
model                         bill quota  intel   code tbHard  $/1M  tok/s code/$
anthropic/claude-opus-5       sub   74%    71.2   76.4   42.1     -      -      -
openai-codex/gpt-6-astra      sub   81%    69.8   74.1   39.6     -      -      -
openrouter/glm-5              paid    -    64.3   68.9   31.2  0.62   88.4  111.1
```

Cached locally and revalidated every 4h with an ETag, mirroring how pi refreshes
its own model catalog.

### Never get surprise-billed

Metered providers are gated **at the provider boundary**, not by prompt
instructions, so it covers workflow subagents too. `/provider` shows every
provider you have credentials for and toggles each one:

```
──────────────────────────────────────────────────────────
 Providers
› ● Anthropic      Allowed
  ● OpenAI Codex   Allowed
  ● OpenRouter     Needs Approval
  ● Google         Needs Approval

  Enter/Space to change · Esc to cancel
──────────────────────────────────────────────────────────
```

### Run tests on real hardware

`/remote setup` reads every connectable host in `~/.ssh/config` and lets you
toggle which are eligible. No SSH config? It generates a dedicated key, shows
the one line to run, and verifies.

```
──────────────────────────────────────────────────────────
 Remote Workers
› ● build-box      READY  CPU 4% MEM 12% GPU 0% · 0 jobs
  ● gpu-node       READY  CPU 9% MEM 31% GPU 0% · 0 jobs
  ● old-laptop     UNREACHABLE  connection timed out

  Enter/Space to toggle · Esc to cancel
──────────────────────────────────────────────────────────
```

`remote_test` snapshots your working tree, admission-checks CPU/GPU/disk,
reserves a slot, and **deletes the uploaded source the moment the run ends**,
keeping only `test.log` and `result.json`. Cleanup runs on the worker, so it
still happens if your laptop sleeps.

### Coordinate multiple agents

`agent_board` gives live presence, messaging, repo rooms and coordinator chains
across every running pi agent. `/board` opens the messaging view:

```
╭────────────────────────────────────────────────────────╮
│ Messaging Board  online  · 3 chats                     │
│ 1 repo:pi-plus │ 2 reviewer │ 3 direct                 │
│ ────────────────────────────────────────────────────── │
│ reviewer   rebased onto main, tests green at a1b2c3d   │
│ builder    picking up the parser, leaving lexer alone  │
│ you        ack, I will take the CLI surface            │
│ ────────────────────────────────────────────────────── │
│ Message  > _                                           │
│ enter send · tab next chat · esc close                 │
╰────────────────────────────────────────────────────────╯
```

`/board setup` installs the server locally (pi starts it each session) or onto
any Mac or Linux host over SSH, where launchd or systemd brings it back after a
reboot.

---

## Commands

| | |
| --- | --- |
| `/pi-plus` | status modal for every feature |
| `/pi-plus help` | model explains the pack and what is missing |
| `/account` | account hub: toggle, add, reauth, switch routing |
| `/account <provider> add [label]` | add a subscription |
| `/account <provider> reauth [label]` | reauthorize one |
| `/routing standard \| optimal` | main-first, or balance by quota |
| `/usage [on\|off\|text]` | quota bars |
| `/models [sort]` | ranked catalog |
| `/model-info <id>` | every benchmark for one model |
| `/model-info refresh` | force a benchmark refresh |
| `/model-info setup` | add the Artificial Analysis key |
| `/provider` | provider toggle picker |
| `/provider approve \| remove <name>` | grant or revoke |
| `/remote setup` | worker hub: toggle, add, rename, remove |
| `/remote add \| rename \| remove` | jump to one step |
| `/board` | live agent board UI |
| `/board setup \| restart \| clear \| status` | manage the board server |

**Tools available to the agent:** `list_models`, `agent_board`, `remote_status`,
`remote_test`.

---

## Configuration

Everything lives in one file, `~/.pi/agent/pi-plus.json`, created on first use:

```json
{
  "env":    { "ARTIFICIAL_ANALYSIS_API_KEY": "aa_…", "AGENT_BOARD_URL": "ws://…" },
  "policy": { "autoApprove": [], "requireApproval": [], "deny": [] },
  "remote": { "workers": [] }
}
```

Real environment variables of the same name always win, so CI and shell
overrides work unchanged. Older `model-quality-key.json`, `agent-board.json` and
`remote-workers.json` are migrated automatically and left in place.

---

## Architecture

Layered by dependency direction, grouped by domain. Each domain owns its own
commands, tools and widgets.

```
src/
  core/       zero pi imports, pure and unit-testable
              store · config · env · quota · catalog · policy · exec · accounts
  services/   stateful singletons with lifecycle + subscribe()
              usage-service, the single quota poller
  ui/         dumb render primitives: format · usage-bars
  domains/    one pi extension entry each
              setup · subscriptions · models · agents · remote
  vendor/     anthropic.ts, the only file importing @cortexkit/*
server/       the agent board server, one file and one dependency (ws)
```

```sh
npm install && npm run verify   # typecheck + 106 tests
```

---

## Built on

pi-plus is a thin layer over other people's work.

| project | what it does here | license |
| --- | --- | --- |
| [`pi`](https://pi.dev/) | the host agent and the entire extension API | MIT |
| [`xxhash-wasm`](https://github.com/jungomi/xxhash-wasm) | vendored into `src/core/anthropic/vendor/` for the billing checksum | MIT |

The Anthropic provider, OAuth, quota and routing were originally adopted from
[`@cortexkit/pi-anthropic-auth`](https://github.com/cortexkit/anthropic-auth)
(MIT) and have since been reimplemented in this repository.


## License

MIT


## Disclaimer

pi-plus is an unofficial, independent project. It is not affiliated with,
endorsed by, or supported by Anthropic, OpenAI, pi, or any other provider
named here.

**You are responsible for using it within the terms of service of every
provider you connect it to.** This tool manages credentials for accounts you
already own and pools requests across them. Whether that is permitted, and
whether a given account may be used for a given purpose, is governed by your
agreement with that provider and not by this software. Review those terms
before connecting an account, and keep in mind that they change.

Provided as is, without warranty of any kind. See [LICENSE](LICENSE).
