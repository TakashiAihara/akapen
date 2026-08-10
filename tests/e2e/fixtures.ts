/**
 * Every test gets its own server, its own markdown file and its own store.
 *
 * akapen is one file per process and comments accumulate in the store. Sharing one
 * server leaks the previous test's comments into the next and breaks any assertion
 * that counts them — eight of them piled up and it failed. Isolate rather than
 * writing the tests around it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from '@playwright/test';

const FIXTURE_MD = join(import.meta.dirname, 'fixture.md');

let nextPort = 4400;

export type Akapen = {
  url: string;
  /** The live file, for imitating an agent's edit. */
  file: string;
  append: (text: string) => void;
};

export const test = base.extend<{ akapen: Akapen }>({
  // Playwright requires a destructuring pattern as the first argument; a named one
  // fails with "First argument must use the object destructuring pattern".
  // oxlint-disable-next-line no-empty-pattern
  akapen: async ({}, use) => {
    const port = nextPort++;
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-e2e-'));
    const file = join(sandbox, 'note.md');
    writeFileSync(file, readFileSync(FIXTURE_MD, 'utf8'));

    const proc: ChildProcess = spawn('bun', ['run', 'src/cli.ts', file, '-p', String(port)], {
      env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home') },
      stdio: 'ignore',
    });

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${url}/api/doc`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`akapen did not start: ${url}`);
      await new Promise((r) => setTimeout(r, 150));
    }

    await use({
      url,
      file,
      append: (text: string) => writeFileSync(file, readFileSync(file, 'utf8') + text),
    });

    proc.kill();
    rmSync(sandbox, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
