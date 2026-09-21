<div align="center">

<img src="images/pi-plus.svg" alt="pi-plus" width="160">

**Everything [pi](https://pi.dev/) is missing, in one install.**

[![npm](https://img.shields.io/npm/v/@jameslovespancakes/pi-plus?color=%234D9ABF&label=npm)](https://www.npmjs.com/package/@jameslovespancakes/pi-plus)
[![CI](https://github.com/jameslovespancakes/pi-plus/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jameslovespancakes/pi-plus/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-F1BE58)](LICENSE)
[![pi-package](https://img.shields.io/badge/pi--package-F09082)](https://pi.dev/packages)

[Changelog](CHANGELOG.md) · [Releases](https://github.com/jameslovespancakes/pi-plus/releases)

</div>

---

## Install

Requires **pi 0.87.0 or newer**.

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
› ● Subscriptions   2 accounts · quota-aware
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

Add multiple Claude, ChatGPT/Codex, Kimi Code, or xAI/Grok accounts. pi-plus
keeps credentials separate, refreshes them safely, and supports sequential or
quota-aware routing.

```
/accounts add anthropic work
/accounts add kimi-coding personal
/routing quota-aware
```

Your live quota, always in the footer:

```
  Claude Σ2 · 2/2 ready                           Codex · pro
  5h     █████████████████░░░░░░░░░   65% 1h     5h     ███████████████████████░░░   88% 57m
  weekly ███████████████░░░░░░░░░░░   58% 3d     weekly ████████████████████████░░   93% 6d
  Fable  ████████████░░░░░░░░░░░░░░  ~47% 3d
  Work 72% · Personal 58%
```

With more than two accounts only the two most recently used are listed, so the
footer stays a fixed height however many you pool.

Account and routing commands are provider-agnostic. Sequential routing uses
account order; quota-aware routing uses reported capacity and fairly probes
accounts whose provider does not publish quota headers.

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
still happens if your laptop sleeps. Worker capacity is queried only by
`remote_status` or `remote_test`; Pi Plus never injects SSH status into ordinary
chat turns.

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
reboot. Board state is returned only when `agent_board` is called or a real
board message is delivered; background presence snapshots are not added to
model context.

### Orchestrate repeatable workflows

The built-in workflow engine runs named or inline multi-agent workflows with
optional concurrency limits, replay, background runs, worktree isolation, progress,
and usage accounting. `code-review`, `diagnose`, `perf-review`,
`refactor-scout`, and `research` ship in this package—no external workflow
package is installed.

```
/workflow code-review HEAD~3
/workflow research "Compare the current provider implementations"
```

The `workflow` tool exposes the same engine to the model. Runs have no agent,
timeout, submission, or token-budget limit by default; set limits explicitly
with workflow options when a task needs them.

---

## Commands

| | |
| --- | --- |
| `/pi-plus` | status modal for every feature |
| `/pi-plus help` | model explains the pack and what is missing |
| `/accounts` | account hub: toggle, add, reauth, switch routing |
| `/accounts add <provider> [label]` | add a subscription |
| `/accounts reauth <provider> [label]` | reauthorize one |
| `/routing sequential \| quota-aware` | account order, or remaining capacity |
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
| `/workflow` | open the running workflow agent board |
| `/workflow <name> [args]` | run a bundled workflow |

**Tools available to the agent:** `workflow`, `list_models`, `agent_board`,
`remote_status`, `remote_test`.

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
              setup · subscriptions · models · workflows · agents · remote
server/       agent board server
config/       example settings and bundled skills
```

```sh
npm install && npm run verify   # lint + type check + tests
```

---

## Built on

pi-plus is a thin layer over other people's work.

| project | what it does here | license |
| --- | --- | --- |
| [`pi`](https://pi.dev/) | the host agent and the entire extension API | MIT |
| [`xxhash-wasm`](https://github.com/jungomi/xxhash-wasm) | vendored into `src/core/anthropic/vendor/` for the billing checksum | MIT |
| [`pi-workflow-engine`](https://github.com/timbrinded/pi-workflow-engine) | embedded workflow runtime and built-in workflows | MIT |

The workflow engine keeps its upstream license in
[`src/domains/workflows/LICENSE.md`](src/domains/workflows/LICENSE.md).

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
