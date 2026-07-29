#!/usr/bin/env node
/** The `playtime` command. Parsing and rendering live elsewhere; this is the shell. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { daily, isoDate } from '../core/daily.js';
import { HARNESS_LABELS } from '../core/events.js';
import { displayProject } from '../core/format.js';
import { rollup } from '../core/rollup.js';
import type { Rollup } from '../core/rollup.js';
import { finalize } from '../core/session.js';
import type { SessionRecord } from '../core/session.js';
import { applySetting, resetSetting } from '../core/settings.js';
import type { Settings } from '../core/settings.js';
import { resolveWindow, tabsFor } from '../core/window.js';
import type { Range, WindowKind } from '../core/window.js';
import { configFromEnv, runDaemon } from '../daemon/daemon.js';
import { aliveProbe, processStartTime } from '../daemon/proc.js';
import { ensureDaemon } from '../daemon/spawn.js';
import { acquireLock } from '../store/lock.js';
import { readLive } from '../store/live.js';
import type { LiveSnapshot } from '../store/live.js';
import { resolvePaths } from '../store/paths.js';
import type { Paths } from '../store/paths.js';
import { inspectSessions, repairSessions } from '../store/repair.js';
import { readSessions } from '../store/sessions.js';
import { loadSettings, saveSettings } from '../store/settings.js';
import { parseCommand } from './args.js';
import type { Command, ReportOptions } from './args.js';
import { runBrowse } from './browse.js';
import { renderSettings } from './settings-view.js';
import { runConfigTui } from './config-tui.js';
import { renderDoctor, renderRepair, runDoctor } from './doctor.js';
import { install, packageRoot } from './install.js';
import { renderOutput, shapeFor } from './output.js';
import { renderStatusline, statuslineJson } from './statusline.js';
import { selectProject } from './select.js';
import { renderDetail, renderLibrary } from './views.js';
import type { ViewContext } from './views.js';

const HELP = `playtime - Steam-style playtime tracking for CLI agent harnesses

Reports
  playtime                     everything, with tabs for year, month and today
  playtime today|month|year    open on one window (week works too)
  playtime <project>           drill into one project
  playtime harness <name>      drill into claude-code, codex or opencode

  In a terminal a report is browsable: tab and shift-tab move between windows,
  q quits. Piped, or in any format but text, it prints one static block.

Other commands
  playtime statusline          one compact line, for ccstatusline
  playtime config              show and change settings
  playtime install             wire up every harness found
  playtime doctor              check hooks, daemon and stored history
  playtime repair              compact history, dropping unreadable lines
  playtime daemon              start the tracker if it is not running

Output format, pick one
  --json                       the whole rollup as JSON, or rows with --rows
  --jsonl                      one JSON object per row
  --csv, --tsv                 delimited rows, with a header
  --template <line>            one line per row, from {tokens}
  --field <path>               one value, for example total.open or projects.0.open
  --format <name>              text, json, jsonl, csv, tsv, template or field

Shaping
  --rows <shape>               totals, harnesses, projects or days
  --units <unit>               human, ms, s, m or h
  --sort <key>                 open, busy, blocked, sessionTime, sessions,
                               turns, last, name or date
  --reverse                    flip the order
  --limit <n>                  keep the first n rows
  --no-header                  leave the csv or tsv header row out

Selecting
  --since <when>               2026-07-01, 7d, today, yesterday, or an epoch
  --until <when>               the same vocabulary
  --project <filter>           a project, by flag rather than by position
  --harness <name>             a harness, by flag rather than by position
  --stacked                    add overlapping sessions up
  --wallclock                  count overlapping sessions once

Text report
  --width <n>                  layout width
  --no-color                   plain output, as does NO_COLOR=1

Columns
  open busy blocked            deduplicated, so overlapping sessions count once
  sessionTime                  open time summed per session instead
  busyStacked blockedStacked   the same, for busy and blocked
  concurrency                  sessionTime divided by open
  share                        busy as a percentage of open
  sessions turns               counts
  lastPlayed start end         ISO 8601 timestamps
  project harness date         what the row is

Other
  --dry-run                    show what install or repair would change
  --foreground                 run the daemon in this terminal

Exit codes
  0 done   1 nothing matched   2 the command line was wrong
`;

async function version(): Promise<string> {
  const manifest = await readFile(join(packageRoot(), 'package.json'), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

interface Loaded {
  records: SessionRecord[];
  live: LiveSnapshot | null;
}

/**
 * History plus whatever is open right now. Live sessions are finalized at their
 * last confirmed-alive moment so the CLI agrees with the daemon exactly.
 */
async function load(paths: Paths): Promise<Loaded> {
  const stored = await readSessions(paths);
  const live = await readLive(paths);
  const provisional = (live?.tracking ?? []).map((state) => finalize(state, state.lastAlive));

  return { records: [...stored.items, ...provisional], live };
}

type Report = Extract<Command, ReportOptions>;

/** Says what an explicit range covers, since no window name describes it. */
function rangeLabel(range: Range | undefined): string | undefined {
  if (!range) return undefined;
  if (range.since !== undefined && range.until !== undefined) {
    return `${isoDate(range.since)} to ${isoDate(range.until)}`;
  }
  if (range.since !== undefined) return `since ${isoDate(range.since)}`;
  if (range.until !== undefined) return `until ${isoDate(range.until)}`;
  return undefined;
}

function context(
  command: Report,
  settings: Settings,
  now: number,
  tabs?: readonly WindowKind[],
): ViewContext {
  const colorAllowed = Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] === undefined;

  return {
    now,
    home: homedir(),
    width: command.output.width ?? process.stdout.columns ?? 80,
    window: command.window,
    label: rangeLabel(command.range),
    count: command.count ?? settings.count,
    projectLimit: command.output.limit ?? settings['projects.limit'],
    color: command.output.color === false ? false : colorAllowed,
    tabs,
  };
}

/**
 * Runs a report in whichever form was asked for: machine-readable in one shot,
 * or the human report, browsable by tab when a terminal is attached.
 */
async function report(
  command: Report,
  settings: Settings,
  records: readonly SessionRecord[],
  render: (data: Rollup, ctx: ViewContext) => string,
): Promise<number> {
  if (command.output.format !== 'text') {
    const now = Date.now();
    const window = resolveWindow(command.window, command.range, now);
    const data = rollup(records, window);
    const days = shapeFor(command.output) === 'days' ? daily(records, window, now) : [];

    const rendered = renderOutput(data, days, command.output);
    process.stdout.write(rendered.text);
    return rendered.found ? 0 : 1;
  }

  // Each tab is drawn when it is opened, so its clock and its window are both
  // current rather than fixed when the command started.
  const draw = (window: WindowKind, tabs?: readonly WindowKind[]): string => {
    const now = Date.now();
    const clip = resolveWindow(window, command.range, now);
    return render(rollup(records, clip), context({ ...command, window }, settings, now, tabs));
  };

  // Explicit dates are not one of the tabs, so browsing them would be a lie.
  const browsable = process.stdin.isTTY && process.stdout.isTTY && command.range === undefined;
  if (!browsable) {
    process.stdout.write(draw(command.window));
    return 0;
  }

  const windows = tabsFor(command.window);
  return runBrowse({ windows, window: command.window, draw: (window) => draw(window, windows) });
}

/** ccstatusline passes context on stdin; a terminal has none to give. */
async function readStdinJson(): Promise<Record<string, unknown> | null> {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return null;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function statusline(
  paths: Paths,
  command: Extract<Command, { kind: 'statusline' }>,
  settings: Settings,
) {
  const snapshot = await readLive(paths);

  if (command.json) {
    process.stdout.write(`${statuslineJson(snapshot)}\n`);
    return;
  }

  const stdin = await readStdinJson();
  const fromStdin = stdin?.['terminal_width'];
  const width =
    command.width ?? (typeof fromStdin === 'number' ? fromStdin : process.stdout.columns);

  const line = renderStatusline(snapshot, {
    format: command.format ?? settings['statusline.format'],
    window: settings['statusline.window'],
    count: settings.count,
    width,
  });
  process.stdout.write(line === '' ? '' : `${line}\n`);
}

async function config(command: Extract<Command, { kind: 'config' }>): Promise<number> {
  const loaded = await loadSettings();

  if (command.action === 'show') {
    // Piped output stays plain text so it can be read by other tools.
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (interactive) return runConfigTui(loaded);

    process.stdout.write(renderSettings(loaded));
    return 0;
  }

  const result =
    command.action === 'set'
      ? applySetting(loaded.settings, command.key, command.value)
      : resetSetting(loaded.settings, command.key);

  if (!result.ok) {
    process.stderr.write(`playtime: ${result.error}\n`);
    return 2;
  }

  await saveSettings(loaded.path, result.settings);
  process.stdout.write(`${command.key} is now ${String(result.settings[command.key as keyof Settings])}\n`);
  return 0;
}

async function repair(
  paths: Paths,
  command: Extract<Command, { kind: 'repair' }>,
): Promise<number> {
  if (command.dryRun) {
    const found = await inspectSessions(paths);
    process.stdout.write(
      renderRepair({
        lines: found.lines,
        kept: found.records.length,
        unreadable: found.unreadable,
        superseded: found.superseded,
        changed: false,
        backup: null,
      }, true),
    );
    return 0;
  }

  try {
    process.stdout.write(renderRepair(await repairSessions(paths), false));
    return 0;
  } catch (error) {
    process.stderr.write(`playtime: ${(error as Error).message}\n`);
    return 1;
  }
}

async function main(): Promise<number> {
  const now = Date.now();
  const command = parseCommand(process.argv.slice(2), now);
  const paths = resolvePaths();
  const { settings } = await loadSettings();

  switch (command.kind) {
    case 'error':
      process.stderr.write(`playtime: ${command.message}\n\n${HELP}`);
      return 2;

    case 'help':
      process.stdout.write(HELP);
      return 0;

    case 'version':
      process.stdout.write(`${await version()}\n`);
      return 0;

    case 'statusline':
      await statusline(paths, command, settings);
      return 0;

    case 'config':
      return config(command);

    case 'doctor':
      process.stdout.write(renderDoctor(await runDoctor(paths, now)));
      return 0;

    case 'repair':
      return repair(paths, command);

    case 'install': {
      for (const harness of command.harnesses) {
        const result = await install(harness, { dryRun: command.dryRun });
        const suffix = result.detail ? ` (${result.detail})` : '';
        process.stdout.write(
          `  ${HARNESS_LABELS[result.harness].padEnd(12)} ${result.status.padEnd(14)} ${result.target}${suffix}\n`,
        );
      }
      process.stdout.write('\nRestart any running harness sessions to pick the hooks up.\n');
      return 0;
    }

    case 'daemon': {
      if (!command.foreground) {
        const state = await ensureDaemon(paths);
        process.stdout.write(`daemon ${state}\n`);
        return 0;
      }

      const lock = await acquireLock(paths, {
        pid: process.pid,
        startedAt: processStartTime(process.pid) ?? now,
      });
      if (!lock) {
        process.stderr.write('playtime: a daemon is already running\n');
        return 1;
      }

      try {
        await runDaemon(paths, configFromEnv(process.env, settings), {
          now: Date.now,
          isAlive: aliveProbe,
          pid: process.pid,
        });
      } finally {
        await lock.release();
      }
      return 0;
    }

    case 'library': {
      const { records, live } = await load(paths);
      return report(command, settings, records, (data, ctx) => renderLibrary(data, live, ctx));
    }

    case 'harness': {
      const { records } = await load(paths);
      const mine = records.filter((record) => record.harness === command.harness);
      const title = HARNESS_LABELS[command.harness];

      return report(command, settings, mine, (data, ctx) => renderDetail(title, data, ctx));
    }

    case 'detail': {
      const { records } = await load(paths);
      const projects = [...new Set(records.map((record) => record.project))];
      const selection = selectProject(command.filter, projects);

      if (selection.kind === 'none') {
        process.stderr.write(`playtime: nothing tracked matching "${command.filter}"\n`);
        return 1;
      }
      if (selection.kind === 'many') {
        process.stderr.write(`playtime: "${command.filter}" matches several projects:\n`);
        for (const match of selection.matches) {
          process.stderr.write(`  ${displayProject(match, homedir())}\n`);
        }
        return 1;
      }

      const mine = records.filter((record) => record.project === selection.project);
      const title = displayProject(selection.project, homedir());

      return report(command, settings, mine, (data, ctx) => renderDetail(title, data, ctx));
    }
  }
}

process.exitCode = await main();
