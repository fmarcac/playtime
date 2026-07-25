# Playtime

Steam-style playtime tracking for CLI agent harnesses: Claude Code, Codex and OpenCode.

Steam tells you that you have 412 hours in a game and which ones you played this
week. Nothing does that for agent harnesses. Playtime does.

```
PLAYTIME                                                        all time

                     open   agent busy    last used
  Claude Code    386h 04m   141h 22m 36%      today
  Codex           21h 51m     6h 09m 28%  3 days ago
  OpenCode         4h 23m     1h 02m 23%  2 weeks ago

  Hours used
    ~/git/playtime           88h 12m  ██████████████████
    ~/git/dashboard       63h 40m  █████████████
    ~/infra               41h 05m  ████████

  412h 18m open, agent working 148h 33m of it (36%), 9h 12m of that waiting on you
  2,910h of sessions fit inside that, 1.4 running at once
  2,481 turns

  now playing  Claude Code  ~/git/playtime  2h 14m · working
```

## Install

```sh
npm install -g harness-playtime
playtime install
playtime doctor
```

`playtime install` wires up every harness it finds, backing up each settings
file first. Restart running sessions to pick the hooks up. Limit it with
`--harness codex`, or preview with `--dry-run`.

You can also install it from inside a harness:

| Harness | From within the harness | Manual |
|---|---|---|
| Claude Code | `/plugin marketplace add fmarcac/playtime` then `/plugin install playtime` | `playtime install --harness claude-code` |
| Codex | `/plugin marketplace add fmarcac/playtime` then `/plugin install playtime@playtime` | `playtime install --harness codex` |
| OpenCode | add `"plugin": ["harness-playtime"]` to `opencode.json` | `playtime install --harness opencode` |

Pick one route per harness. Doing both records every event twice.

## What it measures

**Open time** is wall-clock time a harness was running. It is a union, never a
sum: three windows open at once for an hour is one hour, not three.

**Busy time** is time the agent was working, from prompt submitted until it
stops. Also a union, so fanning out to ten subagents cannot inflate it.

**Blocked time** is the slice of busy time spent waiting on you at a permission
prompt.

**Sessions at once** is raw session hours divided by wall clock. At 1.0 you work
one session at a time; at 2.4 you usually have more than two going.

If you would rather see hours added up than deduplicated, switch counting mode:

```sh
playtime config set count stacked     # or pass --stacked for one run
```

## Commands

```
playtime                     everything, all time
playtime today|week|month    narrow to a window
playtime <project>           drill into one project
playtime harness <name>      drill into claude-code, codex or opencode
playtime statusline          one compact line for status bars
playtime config              show and change settings
playtime install             wire up every harness found
playtime doctor              check hooks, daemon and stored history
playtime daemon              start the tracker if it is not running
```

Add `--json` to any report. `--stacked` and `--wallclock` override the counting
mode for a single run.

## ccstatusline

```sh
$ playtime statusline
4h12m open · 1h07m busy
```

Add a **Custom Command** widget in ccstatusline's editor, or append this to a
line in `~/.config/ccstatusline/settings.json`:

```json
{
  "id": "a-unique-id",
  "type": "custom-command",
  "commandPath": "playtime statusline",
  "timeout": 3000,
  "color": "gradient:summer"
}
```

It reads one small file, never session history, so a render costs about 33ms
against ccstatusline's 1000ms timeout. ccstatusline passes the terminal width on
stdin and the layout shortens itself when space is tight. With no data yet it
prints nothing and the widget stays hidden.

Change the layout with `playtime config set statusline.format '{project} {open}'`,
or per-run with `--format`. Tokens: `{open}` `{busy}` `{blocked}` `{sessions}`
`{turns}` `{total}` `{concurrency}` `{project}` `{harness}` `{live}`. For other
status bars, `playtime statusline --json` emits the same numbers structured.

## Settings

`playtime config` lists every setting with what it does and what it accepts.

| Setting | Default | Does |
|---|---|---|
| `count` | `wallclock` | `wallclock` dedupes overlapping sessions, `stacked` adds them up |
| `statusline.format` | `{open} open · {busy} busy` | status line template |
| `statusline.window` | `today` | period the bare tokens report |
| `projects.limit` | `12` | project rows under Hours used |
| `daemon.tickMs` | `15000` | how often liveness is sampled |
| `daemon.idleExitMs` | `120000` | how long the daemon lingers when idle |

Stored at `~/.config/playtime/config.json`, holding only what differs from the
defaults.

## How it works

Hooks alone cannot measure this. A session idle for three hours emits no events,
and `SessionEnd` never fires on a `kill -9` or a closed terminal. So Playtime
samples rather than guesses.

```
 harness events                 daemon                     query
 --------------                 ------                     -----
 Claude Code  |
 hooks        |  emit.sh    inbox/         drain + tick     playtime CLI
 Codex        |----------->  events.jsonl -------------->  sessions.jsonl --> reports
 hooks        |  (~5ms)                    every 15s        live.json     --> statusline
 OpenCode     |                            kill(pid, 0)
 plugin (in-process)
```

Each hook runs a POSIX `sh` shim that stamps a timestamp and appends the payload
verbatim. It parses nothing and starts no Node process, so it stays out of the
way of your tool calls. The daemon does the interpreting, starts itself when a
session opens, and exits two minutes after the last one closes. Nothing to
manage; if it dies, the next hook brings it back.

It stores intervals rather than samples, one line per session, so years of
history stay small enough to parse on every command.

Things it deliberately gets right:

- **A sleeping laptop counts for nothing.** Liveness is interpolated only across
  short gaps. Close the lid for eight hours and that time is excluded.
- **A killed daemon does not lose in-flight sessions.** `live.json` is a
  checkpoint. The successor resumes from the last confirmed-alive moment, so the
  outage is never credited.
- **A recycled pid does not resurrect a dead session.** Process start times are
  recorded next to pids.
- **Failures undercount, never overcount.** If anything breaks, time stops
  accruing.

## Limitations

**Blocked time is approximate.** No harness emits an event when you approve a
permission prompt, so it is measured from the prompt to the completion of the
tool it gated. That overstates the wait for a long-running tool.

**Pid tracking is best on Linux.** The shim walks `/proc` with shell builtins.
macOS and BSD fall back to `ps`, which is slower, and have no cheap process
start time, so pid reuse is not guarded there.

**Per-project rows can exceed the total.** Each row unions only its own
project's sessions, so time on two projects at once counts for both. A project
row answers "how long did I spend on this".

**Counts are per session.** Windowed views clip durations exactly, but a
session's turn count is attributed whole to any window it overlaps.

## Data

Everything is local. Nothing is sent anywhere.

```
${XDG_DATA_HOME:-~/.local/share}/playtime/
  sessions.jsonl    append-only history, one line per session
  live.json         open sessions, cached totals, daemon checkpoint
  inbox/            hook drop box, drained every tick
  daemon.lock       single-instance lock
  daemon.log        diagnostics, size capped
```

Set `PLAYTIME_HOME` to move it.

## Development

```sh
npm install       # builds via the prepare step
npm test          # builds, then runs the suite
npm run typecheck
```

The interval engine is pure and property-tested: union is idempotent,
order-independent, and never exceeds either the naive sum or its own span. The
daemon takes an injectable clock and process probe, so its tests are
deterministic and never sleep. One test spawns the real daemon entrypoint,
because an in-process test cannot catch a daemon that fails to keep its own
event loop alive.

## License

MIT
