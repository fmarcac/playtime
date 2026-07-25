#!/usr/bin/env node
// Make the built CLI entrypoint executable so the npm bin symlink works.
import { chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

for (const rel of ['dist/cli/index.js', 'dist/daemon/main.js']) {
  await chmod(join(root, rel), 0o755).catch(() => {});
}
