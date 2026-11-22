# dsh-plugin-session-guard

[![ci](https://github.com/jjp-111/dsh-session-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/jjp-111/dsh-session-guard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Cost-aware session guard for [DeepSeek Harness](https://github.com/deepseek-ai).**
Remind at a tool-call threshold, ask a context/cost gate whether the session is
actually expensive, and only then hand off to a fresh session — with a persisted
daily breaker, a single-flight lock, and idempotent handoff notes.

> Long agent sessions get more expensive per call as the context grows, but
> switching sessions loses all working context. This plugin tries to make that
> trade-off explicit and boring instead of a judgement call every time.

---

## The problem

In a coding-agent session the prompt is re-sent on every request. Cost per call
therefore grows with the conversation, roughly linearly, while the value of each
extra turn usually does not. The usual advice — "start a new session" — has two
failure modes:

1. **Too early**: you throw away context you still need, and pay to rebuild it.
2. **Too late**: the last 20 turns cost several times what the first 20 did.

A plain "remind me every 40 tool calls" rule gets both wrong, because **tool-call
count is not a cost signal**. Forty calls in a 20k-token session is cheap; eight
calls in a 200k-token session is not.

## What this plugin does

It separates *triggering* from *deciding*:

```
tool call ──▶ threshold hit? ──no──▶ nothing
                    │yes
                    ▼
            cost gate (ctx / cost) ──"not yet"──▶ soft reminder: keep working
                    │"long"
                    ▼
            handoffMode ──ask──▶ prompt the user, do nothing
                    │auto
                    ▼
            write handoff note ─▶ create session ─▶ rename ─▶ deliver prompt
                    │
                    ▼
            persist daily counter (survives restarts)
```

The key design choice: **the gate decides, the threshold only asks.** A session
that is not actually expensive gets a one-line notice that explicitly says
*do not hand off* — it never gets instructions to start a new session.

## Install

From the DSH plugin manager (recommended):

```
dsh plugin --profile <name> add dsh-plugin-session-guard
```

Or as a local link during development:

```
dsh plugin --profile <name> add "link:/absolute/path/to/dsh-session-guard"
```

Then restart the Host once — `cordis.patch.yml` is read at startup.

## Configuration

All keys are optional; defaults live in [`cordis.patch.yml`](./cordis.patch.yml).
Override them from your own profile patch layer:

```yaml
- id: session-guard
  config:
    thresholds: [120, 240]
    handoffMode: ask
    gateMinContext: 250000
```

| Key | Default | Meaning |
|---|---|---|
| `thresholds` | `[80, 160, 320]` | Tool-call counts that trigger a check |
| `handoffMode` | `ask` | `auto` hands off itself · `ask` prompts the user · `off` reminds only |
| `text` | built-in | Reminder template, `{count}` is substituted |
| `group` | — | Force one group id instead of inferring it |
| `defaultGroup` | — | Fallback group; empty means "skip rather than guess" |
| `groupsConfig` | `<cwd>/tools/session-groups/groups.config.json` | Where group definitions live |
| `handoffDir` | `<cwd>/.team/handoff` | Where handoff notes are written |
| `reportFile` | `<cwd>/reports/session-groups.json` | Last-resort group lookup |
| `maxHandoffs` | `3` | Max automatic handoffs per calendar day |
| `minGapMs` | `1800000` | Minimum gap between two handoffs |
| `gateEnabled` | `true` | Run the cost gate before handing off |
| `gateScript` | `tools/session-gate/gate.mjs` | Gate executable (exit code 3 = "long") |
| `gateMinContext` | `180000` | Prompt size that counts as long |
| `gateMaxCost` | `4` | Session cost in CNY that counts as long |
| `timeoutMs` | `10000` | Whole-handoff timeout |
| `stateDir` | `<cwd>/.team/session-guard` | Pause file, breaker state, diagnostics |

## Design decisions

These are the parts worth reading if you are reviewing the code.

**1. Fail closed, never fail open.** Every optional dependency — the gate script,
the session controller, the flush — can fail. Each failure path degrades to
*"remind, do not hand off"*. A broken gate can never cause an extra session.

**2. Persisted breaker, not in-memory.** The first version kept the daily counter
in memory, so restarting the Host silently reset the brake — and restarting was
exactly what a user does when a runaway loop starts. The counter now lives in
`state.json`, is normalised on read (bad JSON → 0, wrong day → 0), and is written
*before* the handoff returns.

**3. Idempotent by construction.** A handoff note is named with the source
session id. If a note already exists for that session, the plugin refuses to
create a second one — which also makes crash-then-retry safe.

**4. Single-flight + one-shot per agent.** A lock prevents two handoffs running at
once, and an agent that has already handed off is never handed off again in the
same process.

**5. Child sessions never hand off.** The plugin renames the session it creates
with a recognisable `【group】handoff:` prefix. Seeing that prefix on itself means
"stop": otherwise each handoff would spawn another, forever.

**6. Pause is a file, not a config.** `.team/session-guard/PAUSE` takes effect
without a restart, because in an incident the restart itself is the slow,
error-prone step.

**7. The gate is a separate process.** It reads session logs from disk and exit-codes
its verdict, so it can be replaced or tested independently of the plugin.

## Verification

The plugin ships with unit tests that exercise the guard without a Host: fake
`ctx`, fake `sessions`/`sessionController`, and a temporary state dir.

```bash
npm test
```

Covered: threshold gating, gate rejection (no handoff), the full happy path
(note → create → rename → deliver → flush → persisted count), idempotency across
thresholds, create failure, flush failure, timeout, child-session suppression,
the daily breaker and its day rollover, the PAUSE file, and restart persistence.

## Limitations

- Group inference is a convention (`【group】` title prefix, keywords, a report
  file). It is deliberately conservative: when nothing matches, the plugin skips
  the handoff instead of guessing a group.
- The gate is only as good as its script; the bundled default expects a specific
  session-log layout.
- `cordis.patch.yml` is not hot-reloaded. Changing thresholds requires a restart —
  which is why `PAUSE` exists as the runtime switch.
- Written against DSH `0.2.2-rc.5`. Host APIs may move.

## Related

Three projects built on the same idea — **turn judgement into something you can run twice**:

- **[dsh-session-ledger](https://github.com/jjp-111/dsh-session-ledger)** — prices historical sessions and replays policies, so a rule can be chosen on evidence instead of instinct.
- **[novel-lint](https://github.com/jjp-111/novel-lint)** — the same approach applied to prose: mechanical checks for a manuscript.

## License

MIT
