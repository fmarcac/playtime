/**
 * The tabbed report loop.
 *
 * Like the settings screen, it redraws its own block in place rather than
 * taking over the terminal, so the report scrolls with your scrollback and the
 * tab you were last looking at is left on screen when you quit. Rendering is
 * the caller's job; this file is the keyboard loop and nothing else.
 */

import { createInterface, emitKeypressEvents } from 'node:readline';

import type { WindowKind } from '../core/window.js';

const ESC = '';

interface Key {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
}

export interface BrowseOptions {
  /** The tabs, in the order they are shown. */
  windows: readonly WindowKind[];
  /** The tab to open on. */
  window: WindowKind;
  /** Renders the whole report for one window, ending in a newline. */
  draw: (window: WindowKind) => string;
}

/** How far the given key moves along the strip, or 0 if it moves nothing. */
export function step(key: Key): number {
  if (key.name === 'tab') return key.shift ? -1 : 1;
  if (key.name === 'right' || key.name === 'l') return 1;
  if (key.name === 'left' || key.name === 'h') return -1;
  return 0;
}

export async function runBrowse(options: BrowseOptions): Promise<number> {
  const windows = options.windows;
  let at = Math.max(0, windows.indexOf(options.window));
  let drawn = 0;

  const render = (): void => {
    // Step back over the block just written and clear from there down.
    if (drawn > 0) process.stdout.write(`${ESC}[${drawn}A${ESC}[0J`);

    const text = options.draw(windows[at] ?? options.window);
    process.stdout.write(text);
    drawn = text.split('\n').length - 1;
  };

  emitKeypressEvents(process.stdin);
  const keepAlive = createInterface({ input: process.stdin });
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  render();

  try {
    await new Promise<void>((resolve) => {
      // A resized terminal changes the width every row was laid out against.
      const onResize = (): void => render();

      const onKey = (_chunk: string, key: Key | undefined): void => {
        if (!key) return;

        if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          process.stdin.off('keypress', onKey);
          process.stdout.off('resize', onResize);
          resolve();
          return;
        }

        const move = step(key);
        if (move === 0) return;

        at = (at + move + windows.length) % windows.length;
        render();
      };

      process.stdin.on('keypress', onKey);
      process.stdout.on('resize', onResize);
    });
  } finally {
    process.stdin.setRawMode?.(false);
    keepAlive.close();
    process.stdin.pause();
  }

  return 0;
}
