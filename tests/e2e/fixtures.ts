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
import { isAbsolute, join, resolve } from 'node:path';
import { test as base } from '@playwright/test';

const FIXTURE_MD = join(import.meta.dirname, 'fixture.md');

/**
 * The token every server in the E2E run is started with.
 *
 * Fixed, so the fixture can put it in the browser's jar before the first navigation.
 * The browser then behaves exactly as it does after a real first visit — cookie only,
 * nothing in any URL — which is the state every test here is about.
 */
export const TOKEN = 'test-token-for-the-e2e-run';

/** For requests made outside the browser, which keep no jar. */
export const AUTH = { authorization: `Bearer ${TOKEN}` };

let nextPort = 4400;

export type Akapen = {
  url: string;
  /** The credential this instance was started with, for a test that presents it itself. */
  token: string;
  /** The live file, for imitating an agent's edit. */
  file: string;
  /** The registry this instance registered in. Sharing it is what makes peers visible. */
  home: string;
  append: (text: string) => void;
};

/**
 * Until the akapen this test started answers for the file it was started on.
 *
 * A 200 alone is not enough. The port comes from a counter every run starts at 4400, and
 * every run uses the same token, so a port held by another e2e run on the same host answers
 * just as well — usually before the process started here has even reached its bind and
 * exited on it. The test would then measure the other run's document (#277). The path is
 * what tells them apart. The exit, with what the process wrote to stderr, is what says why
 * the right one never will, instead of a deadline twenty seconds later.
 *
 * Called straight after `spawn`, before anything awaits, so no exit or output is missed.
 * stderr stays drained for the life of the process, so a chatty server never blocks on it.
 */
async function waitUntilServing(url: string, file: string, proc: ChildProcess): Promise<void> {
  const want = resolve(file);
  const deadline = Date.now() + 20_000;
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });
  // `close`, not `exit`: it comes after stderr has been read to the end. Either a code or a
  // signal, so a process killed from outside fails here too rather than at the deadline.
  let ended: string | null = null;
  proc.once('close', (code, signal) => {
    ended = signal ? `signal ${signal}` : `code ${code}`;
  });

  let answered = '';
  for (;;) {
    if (ended !== null) {
      throw new Error(`akapen exited before serving ${want} at ${url} (${ended}): ${stderr.trim()}`);
    }
    try {
      // Each attempt is given its own deadline. A server that accepts the connection and
      // then never answers would otherwise hold this open past the loop's deadline, and
      // "did not start" would arrive as a test timeout with nothing said about why.
      const res = await fetch(`${url}/api/doc`, { headers: AUTH, signal: AbortSignal.timeout(2_000) });
      if (res.ok) {
        answered = ((await res.json()) as { doc: { path: string } }).doc.path;
        if (answered === want) return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`akapen did not start: ${url}${answered ? ` (serving ${answered}, not ${want})` : ''}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * A second akapen sharing a registry with the first, for the switcher and for a port
 * reused by another document (#177).
 *
 * Not part of the fixture: only those want one, and every other test would pay for a
 * second process it never looks at. `name` is a file name in a fresh sandbox, or an
 * absolute path to serve an existing file, so the same document can be started again.
 */
export async function startPeer(
  home: string,
  name: string,
  extra: string[] = [],
  /** A port to take again, for a test of what happens when one is reused. */
  reuse?: number,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const port = reuse ?? nextPort++;
  const sandbox = mkdtempSync(join(tmpdir(), 'akapen-e2e-peer-'));
  const file = isAbsolute(name) ? name : join(sandbox, name);
  if (!isAbsolute(name)) writeFileSync(file, readFileSync(FIXTURE_MD, 'utf8'));

  const proc: ChildProcess = spawn(
    'bun',
    ['run', 'packages/cli/src/cli.ts', file, '-p', String(port), ...extra],
    { env: { ...process.env, AKAPEN_HOME: home, AKAPEN_TOKEN: TOKEN }, stdio: ['ignore', 'ignore', 'pipe'] },
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
    await waitUntilServing(`http://127.0.0.1:${port}`, file, proc);
  } catch (err) {
    // The caller never receives a handle when this throws, so nothing else can stop it
    await stop();
    throw err;
  }

  return { port, stop };
}

export const test = base.extend<{ akapen: Akapen }>({
  akapen: async ({ context }, use) => {
    const port = nextPort++;
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-e2e-'));
    const file = join(sandbox, 'note.md');
    writeFileSync(file, readFileSync(FIXTURE_MD, 'utf8'));

    const home = join(sandbox, 'home');
    const proc: ChildProcess = spawn('bun', ['run', 'packages/cli/src/cli.ts', file, '-p', String(port)], {
      env: { ...process.env, AKAPEN_HOME: home, AKAPEN_TOKEN: TOKEN },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const url = `http://127.0.0.1:${port}`;

    // From here on the process exists, so every exit has to go through the same cleanup.
    // A server that never comes up, or a cookie that will not seed, would otherwise leave
    // a bun process holding the port and a sandbox on disk for the rest of the run.
    try {
      await waitUntilServing(url, file, proc);

      // What a browser holds after one visit to the printed URL. Seeding it here rather
      // than navigating to `?token=` first keeps every test's opening navigation the real
      // one — the bare URL, which is what both a bookmark and a reload are.
      await context.addCookies([{ name: 'akapen_token', value: TOKEN, url }]);

      await use({
        url,
        token: TOKEN,
        file,
        home,
        append: (text: string) => writeFileSync(file, readFileSync(file, 'utf8') + text),
      });
    } finally {
      // Waited for, not just signalled — the same as `startPeer`. Removing the sandbox
      // while the server is still shutting down leaves it writing into a directory that
      // is going away, and leaves the port held into the next test.
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>((done) => proc.once('exit', () => done()));
        proc.kill();
        await exited;
      }
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
});

export { expect } from '@playwright/test';
