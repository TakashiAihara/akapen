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
  /** The registry this instance registered in. Sharing it is what makes peers visible. */
  home: string;
  append: (text: string) => void;
};

async function waitUntilServing(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      // Each attempt is given its own deadline. A server that accepts the connection and
      // then never answers would otherwise hold this open past the loop's deadline, and
      // "did not start" would arrive as a test timeout with nothing said about why.
      if ((await fetch(`${url}/api/doc`, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`akapen did not start: ${url}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * A second akapen sharing a registry with the first, for the switcher.
 *
 * Not part of the fixture: only the switcher wants one, and every other test would pay
 * for a second process it never looks at.
 */
export async function startPeer(
  home: string,
  name: string,
  extra: string[] = [],
): Promise<{ port: number; stop: () => Promise<void> }> {
  const port = nextPort++;
  const sandbox = mkdtempSync(join(tmpdir(), 'akapen-e2e-peer-'));
  const file = join(sandbox, name);
  writeFileSync(file, readFileSync(FIXTURE_MD, 'utf8'));

  const proc: ChildProcess = spawn(
    'bun',
    ['run', 'packages/cli/src/cli.ts', file, '-p', String(port), ...extra],
    { env: { ...process.env, AKAPEN_HOME: home }, stdio: 'ignore' },
  );

  /**
   * Waited for, not just signalled. The peer removes its registry entry as it shuts
   * down, so a test that stops one and then asks what is running would otherwise be
   * asking while it is still there — passing or failing on timing.
   */
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((done) => proc.once('exit', () => done()));
      proc.kill();
      await exited;
    }
    rmSync(sandbox, { recursive: true, force: true });
  };

  try {
    await waitUntilServing(`http://127.0.0.1:${port}`);
  } catch (err) {
    // The caller never receives a handle when this throws, so nothing else can stop it
    await stop();
    throw err;
  }

  return { port, stop };
}

export const test = base.extend<{ akapen: Akapen }>({
  // Playwright requires a destructuring pattern as the first argument; a named one
  // fails with "First argument must use the object destructuring pattern".
  // oxlint-disable-next-line no-empty-pattern
  akapen: async ({}, use) => {
    const port = nextPort++;
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-e2e-'));
    const file = join(sandbox, 'note.md');
    writeFileSync(file, readFileSync(FIXTURE_MD, 'utf8'));

    const home = join(sandbox, 'home');
    const proc: ChildProcess = spawn('bun', ['run', 'packages/cli/src/cli.ts', file, '-p', String(port)], {
      env: { ...process.env, AKAPEN_HOME: home },
      stdio: 'ignore',
    });

    const url = `http://127.0.0.1:${port}`;
    await waitUntilServing(url);

    await use({
      url,
      file,
      home,
      append: (text: string) => writeFileSync(file, readFileSync(file, 'utf8') + text),
    });

    proc.kill();
    rmSync(sandbox, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
