import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  home: string;
  inbox: string;
  sessions: string;
  live: string;
  lock: string;
  log: string;
}

/**
 * Resolves the data directory. `PLAYTIME_HOME` wins, then the XDG data
 * directory, then the XDG default. Every hook, the daemon and the CLI resolve
 * this the same way so they always agree on where the data lives.
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home =
    env['PLAYTIME_HOME'] ??
    join(env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'playtime');

  return {
    home,
    inbox: join(home, 'inbox', 'events.jsonl'),
    sessions: join(home, 'sessions.jsonl'),
    live: join(home, 'live.json'),
    lock: join(home, 'daemon.lock'),
    log: join(home, 'daemon.log'),
  };
}
