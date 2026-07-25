# Playtime

Steam-style playtime tracking for CLI agent harnesses.

Steam will tell you that you have 412 hours in a game and which ones you played
this week. Nothing does that for Claude Code, Codex or OpenCode. Playtime does.

```
PLAYTIME                                                        all time

  Claude Code    386h 04m   busy 141h 22m  36%   today
  Codex           21h 51m   busy   6h 09m  28%   3 days ago
  OpenCode         4h 23m   busy   1h 02m  23%   2 weeks ago

  Hours used
    ~/git/playtime           88h 12m  ██████████████████
    ~/git/dashboard       63h 40m  █████████████
    ~/infra               41h 05m  ████████

  412h 18m open  ·  148h 33m busy  ·  1.4x sessions deep  ·  2,481 turns

  now playing  Claude Code  ~/git/playtime  2h 14m · working
```

## What it measures

Three numbers, and the difference between them is the point.

**Open time** is wall-clock time a harness was running. It is a union, never a
sum: three windows open at once for an hour is one hour, not three.

**Busy time** is time the agent was working, from the moment you submit a prompt
until it stops. Also a union, so fanning out to ten subagents cannot inflate it.

**Blocked time** is the part of busy time the agent spent waiting on you at a
permission prompt. Reported as a subset of busy.

Alongside those, **sessions deep** is the ratio of raw session hours to wall
clock. At 1.0 you work one session at a time. At 2.4 you are usually running
more than two at once.

## Install

Not published to npm yet, so install it from a clone:

```sh
git clone https://github.com/fmarcgh/playtime && cd playtime
npm install          # builds via the prepare step
npm link             # puts `playtime` on your PATH
playtime install
```

`npm link` symlinks the checkout, so a later `git pull && npm run build` updates
the installed command in place. To install a fixed copy instead, use
`npm pack` and then `npm install -g ./harness-playtime-*.tgz`. Once published,
this all collapses to `npm install -g harness-playtime`.

`playtime install` wires up every harness it can find, backing up each settings
file first. Restart any running sessions to pick the hooks up, then check it
took:

```sh
playtime doctor
```

```
PLAYTIME DOCTOR

  ✓ data directory     ~/.local/share/playtime
  ✓ daemon             pid 769937, last tick 6s ago
  ✓ Claude Code hooks  ~/.claude/settings.json
  ! Codex hooks        no config at ~/.codex/hooks.json
  ✓ history            41 sessions, most recent today
  ✓ inbox              empty
```

To install for only one harness, use `playtime install --harness codex`. To see
what would change without changing it, add `--dry-run`.

### As a Claude Code plugin

The repository is also a Claude Code plugin, so you can install it that way
instead. It needs to be built first, since the plugin's hooks call into `dist/`:

```sh
git clone https://github.com/fmarcgh/playtime && cd playtime
npm install && npm run build
```

Then add the directory as a local plugin. Do not do both this and
`playtime install --harness claude-code`, or every event will be recorded twice.

## ccstatusline

Playtime exposes a compact line built for status bars. It reads a single small
file and never touches session history, so it stays fast at a five-second
refresh.

```sh
$ playtime statusline
⏱ 4h12m ▸ 1h07m
```

In ccstatusline's editor, add a **Custom Command** widget running
`playtime statusline`. Or add it straight to
`~/.config/ccstatusline/settings.json`, appended to whichever line you want it
on:

```json
{
  "id": "a-unique-id",
  "type": "custom-command",
  "commandPath": "playtime statusline",
  "timeout": 3000,
  "color": "gradient:summer"
}
```

ccstatusline passes the terminal width on stdin and the default layout shortens
itself when there is not enough room. A render takes about 33ms, well inside the
default timeout. When there is no data yet the command prints nothing, and
ccstatusline hides the widget rather than showing an empty slot.

To change the layout, pass a template:

```sh
playtime statusline --format '{project} {open} / {busy}'
```

| Token | Meaning |
|---|---|
| `{open}` `{busy}` `{blocked}` | today's durations, compact |
| `{sessions}` `{turns}` | today's counts |
| `{total}` | all-time open time |
| `{concurrency}` | sessions deep, for example `1.4x` |
| `{project}` `{harness}` | what is live right now, blank if nothing is |
| `{live}` | number of open sessions |

For any other status line, `playtime statusline --json` emits the same numbers
as structured output.

## Commands

```
playtime                     everything, all time
playtime today|week|month    narrow to a window
playtime <project>           drill into one project
playtime harness <name>      drill into claude-code, codex or opencode
playtime statusline          one compact line
playtime install             wire up every harness found
playtime doctor              check hooks, daemon and stored history
playtime daemon              start the tracker if it is not running
```

Add `--json` to any report for machine-readable output.

## How it works

Hooks alone cannot measure this. A session sitting idle for three hours emits no
events, and `SessionEnd` never fires on a `kill -9` or a closed terminal. So
Playtime samples instead of guessing.

```
 harness events                 daemon                     query
 --------------                 ------                     -----
 Claude Code  |
 hooks.json   |  emit.sh    inbox/         drain + tick     playtime CLI
 Codex        |----------->  events.jsonl -------------->  sessions.jsonl --> reports
 hooks.json   |  (~5ms)                    every 15s        live.json     --> statusline
 OpenCode     |                            kill(pid, 0)
 plugin.js (in-process)
```

Each hook runs a POSIX `sh` shim that stamps a timestamp and appends the harness
payload verbatim. It parses nothing and starts no Node process, so it stays out
of the way of your tool calls. The daemon does all the interpretation.

The daemon starts itself the first time a session opens and exits two minutes
after the last one closes. There is no service to manage. If it dies, the next
hook brings it back.

It stores intervals rather than samples, one line per session, so years of
history stay small enough to parse on every command.

### Things it deliberately gets right

**A sleeping laptop counts for nothing.** Liveness is only interpolated between
observations close together in time. Close the lid for eight hours and the gap
is excluded rather than filled in.

**A killed daemon does not lose your session.** `live.json` is a checkpoint, not
just a display cache. The next daemon adopts whatever was in flight, resuming
from the last confirmed-alive moment so the outage itself is never credited.

**A recycled pid does not resurrect a dead session.** Sessions record the process
start time next to the pid.

**Failures undercount, never overcount.** If anything stops working, time simply
stops accruing.

## Limitations

**Blocked time is approximate.** Neither Claude Code nor Codex emits an event at
the moment you approve a permission prompt, so blocked time is measured from the
prompt to the completion of the tool it was gating. For a long-running tool that
overstates the wait.

**Pid tracking needs `/proc`.** On Linux the shim finds the harness process using
shell builtins alone. On macOS and BSD it falls back to `ps`, which is slower,
and process start times are unavailable so pid reuse is not guarded against.

**Per-project rows can exceed the grand total.** Each row unions only its own
project's sessions, so time spent on two projects at once is counted for both.
That is intended: a project row answers "how long did I spend on this".

**Counts are per session.** In a windowed view, durations are clipped exactly,
but a session's turn count is attributed whole to any window it overlaps.

## Data

Everything is local. Nothing is sent anywhere.

```
${XDG_DATA_HOME:-~/.local/share}/playtime/
  sessions.jsonl    append-only history, one line per session
  live.json         open sessions, cached totals, daemon checkpoint
  inbox/            hook drop box, drained every tick
  daemon.lock       single-instance lock
  daemon.log        daemon diagnostics, size capped
```

Set `PLAYTIME_HOME` to put it elsewhere.

## Development

```sh
npm install
npm test          # builds, then runs the suite
npm run typecheck
```

The interval engine is pure and property-tested: union is idempotent,
order-independent, and never exceeds either the naive sum or its own span. The
daemon takes an injectable clock and process probe, so its tests are fully
deterministic and never sleep.

## License

MIT
