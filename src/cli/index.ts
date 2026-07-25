#!/usr/bin/env node
/** The `playtime` command. Parsing and rendering live elsewhere; this is the shell. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { HARNESS_LABELS } from '../core/events.js';
import { displayProject } from '../core/format.js';
import { rollup } from '../core/rollup.js';
import { finalize } from '../core/session.js';
import type { SessionRecord } from '../core/session.js';
import { windowFor } from '../core/window.js';
import { configFromEnv, runDaemon } from '../daemon/daemon.js';
import { aliveProbe, processStartTime } from '../daemon/proc.js';
import { ensureDaemon } from '../daemon/spawn.js';
import { acquireLock } from '../store/lock.js';
import { readLive } from '../store/live.js';
import type { LiveSnapshot } from '../store/live.js';
import { resolvePaths } from '../store/paths.js';
import type { Paths } from '../store/paths.js';
import { readSessions } from '../store/sessions.js';
import { parseCommand } from './args.js';
import type { Command } from './args.js';
import { renderDoctor, runDoctor } from './doctor.js';
import { install, packageRoot } from './install.js';
import { renderStatusline, statuslineJson } from './statusline.js';
import { selectProject } from './select.js';
import { renderDetail, renderLibrary } from './views.js';
import type { ViewContext } from './views.js';

const HELP = `playtime - Steam-style playtime tracking for CLI agent harnesses

  playtime                     everything, all time
  playtime today|week|month    narrow to a window
  playtime <project>           drill into one project
  playtime harness <name>      drill into claude-code, codex or opencode

  playtime statusline          one compact line, for ccstatusline
  playtime install             wire up every harness found
  playtime doctor              check hooks, daemon and stored history
  playtime daemon              start the tracker if it is not running

Options
  --json                       machine-readable output
  --format <template>          statusline layout, for example "{open} / {busy}"
  --width <n>                  statusline width budget
  --harness <name>             limit install to one harness
  --dry-run                    show what install would change
  --foreground                 run the daemon in this terminal
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

function context(command: Extract<Command, { window: unknown }>, now: number): ViewContext {
  return {
    now,
    home: homedir(),
    width: process.stdout.columns ?? 80,
    window: command.window,
    color: Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] === undefined,
  };
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

async function statusline(paths: Paths, command: Extract<Command, { kind: 'statusline' }>) {
  const snapshot = await readLive(paths);

  if (command.json) {
    process.stdout.write(`${statuslineJson(snapshot)}\n`);
    return;
  }

  const stdin = await readStdinJson();
  const fromStdin = stdin?.['terminal_width'];
  const width =
    command.width ?? (typeof fromStdin === 'number' ? fromStdin : process.stdout.columns);

  const line = renderStatusline(snapshot, { format: command.format, width });
  process.stdout.write(line === '' ? '' : `${line}\n`);
}

async function main(): Promise<number> {
  const command = parseCommand(process.argv.slice(2));
  const paths = resolvePaths();
  const now = Date.now();

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
      await statusline(paths, command);
      return 0;

    case 'doctor':
      process.stdout.write(renderDoctor(await runDoctor(paths, now)));
      return 0;

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
        await runDaemon(paths, configFromEnv(), {
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
      const data = rollup(records, windowFor(command.window, now));

      if (command.json) {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        return 0;
      }

      process.stdout.write(renderLibrary(data, live, context(command, now)));
      return 0;
    }

    case 'harness': {
      const { records } = await load(paths);
      const mine = records.filter((record) => record.harness === command.harness);
      const data = rollup(mine, windowFor(command.window, now));

      if (command.json) {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        return 0;
      }

      process.stdout.write(
        renderDetail(HARNESS_LABELS[command.harness], data, context(command, now)),
      );
      return 0;
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
      const data = rollup(mine, windowFor(command.window, now));

      if (command.json) {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
        return 0;
      }

      process.stdout.write(
        renderDetail(displayProject(selection.project, homedir()), data, context(command, now)),
      );
      return 0;
    }
  }
}

process.exitCode = await main();
