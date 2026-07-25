#!/bin/sh
# Playtime hook shim.
#
# Runs on every harness lifecycle event, so it has to be cheap. It parses
# nothing: it stamps a timestamp, finds the harness process, and appends the
# harness payload verbatim as one JSON line. All interpretation happens later,
# in the daemon, where it is testable.
#
# Usage: emit.sh <harness> <hook-name>   with the hook payload on stdin.
#
# It must never fail a hook, so every step is best effort and the exit is always
# zero.

set -u

harness="${1:-unknown}"
hook="${2:-unknown}"

home="${PLAYTIME_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/playtime}"
inbox="$home/inbox"

# Milliseconds. GNU date does %3N; BSD date leaves it literal, so fall back.
ts=$(date +%s%3N 2>/dev/null) || ts=''
case "$ts" in
  '' | *[!0-9]*) ts="$(date +%s)000" ;;
esac

# JSON escapes newlines inside strings, so raw newlines are only ever whitespace
# between tokens and stripping them cannot corrupt the payload.
payload=$(tr -d '\n\r' 2>/dev/null)
[ -n "$payload" ] || payload='{}'

# Walk up to the harness process. Everything here is a shell builtin, so no
# subprocesses are spawned on the fast path.
harness_pid=''
harness_pid_start=''

if [ -d /proc ]; then
  # The script's own positional parameters were saved above, so `set --` is free
  # to reuse them for splitting. Everything here is builtin: no forks.
  pid="${PPID:-}"
  depth=0
  while [ -n "$pid" ] && [ "$pid" != "1" ] && [ "$depth" -lt 8 ]; do
    comm=''
    read -r comm < "/proc/$pid/comm" 2>/dev/null || break

    statline=''
    read -r statline < "/proc/$pid/stat" 2>/dev/null || break
    # The comm field can contain spaces and parentheses, so split after the
    # last ')'. What remains starts at field 3, making $2 the parent pid and
    # ${20} the start time (fields 4 and 22 of the original).
    set -- ${statline#*") "}
    parent="${2:-}"
    start="${20:-}"

    case "$comm" in
      claude | claude-code | codex | opencode | node | bun | deno)
        harness_pid="$pid"
        harness_pid_start="$start"
        break
        ;;
    esac

    pid="$parent"
    depth=$((depth + 1))
  done
else
  # No /proc, so pay for ps. Only BSD and macOS take this path.
  pid="${PPID:-}"
  depth=0
  while [ -n "$pid" ] && [ "$pid" != "1" ] && [ "$depth" -lt 6 ]; do
    line=$(ps -o ppid=,comm= -p "$pid" 2>/dev/null) || break
    [ -n "$line" ] || break
    set -- $line
    case "${2:-}" in
      *claude* | *codex* | *opencode* | *node* | *bun* | *deno*)
        harness_pid="$pid"
        break
        ;;
    esac
    pid="${1:-}"
    depth=$((depth + 1))
  done
fi

if [ -n "$harness_pid" ]; then
  if [ -n "$harness_pid_start" ]; then
    identity=",\"pid\":$harness_pid,\"pidStart\":$harness_pid_start"
  else
    identity=",\"pid\":$harness_pid"
  fi
else
  identity=''
fi

[ -d "$inbox" ] || mkdir -p "$inbox" 2>/dev/null

printf '{"v":1,"ts":%s,"harness":"%s","hook":"%s"%s,"payload":%s}\n' \
  "$ts" "$harness" "$hook" "$identity" "$payload" >> "$inbox/events.jsonl" 2>/dev/null

# Keep the daemon up. Checking the lock is builtin-only, and starting it again
# is harmless because the daemon itself enforces single instance. This makes the
# system self-healing: a daemon that dies mid-session comes back on the next hook.
lock="$home/daemon.lock"
running=''
if [ -r "$lock" ]; then
  lockline=''
  if read -r lockline < "$lock" 2>/dev/null; then
    pid=${lockline#*\"pid\":}
    pid=${pid%%,*}
    pid=${pid%%\}*}
    case "$pid" in
      '' | *[!0-9]*) pid='' ;;
    esac
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      running=1
    fi
  fi
fi

if [ -z "$running" ]; then
  main="$(dirname "$0")/../../dist/daemon/main.js"
  if [ -r "$main" ]; then
    PLAYTIME_HOME="$home" nohup "${PLAYTIME_NODE:-node}" "$main" \
      >> "$home/daemon.log" 2>&1 &
  fi
fi

exit 0
