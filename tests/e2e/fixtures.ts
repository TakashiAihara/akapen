/**
 * Every test gets its own `akapen serve`, its own markdown file and its own store.
 *
 * Comments accumulate in the store. Sharing one server leaks the previous test's comments
 * into the next and breaks any assertion that counts them — eight of them piled up and it
 * failed. Isolate rather than writing the tests around it. Every server takes the port the
 * OS gives it, so none of them can collide with an akapen someone left running.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test as base } from '@playwright/test';

const FIXTURE_MD = join(import.meta.dirname, 'fixture.md');
const CLI = 'packages/cli/src/cli.ts';

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

export type Akapen = {
  /** The document, under `akapen serve`: `/d/<id>`, without a trailing slash. */
  url: string;
  /** The server itself, where its assets are and where the list of documents is. */
  origin: string;
  /** The credential this instance was started with, for a test that presents it itself. */
  token: string;
  /** The live file, for imitating an agent's edit. */
  file: string;
  home: string;
  append: (text: string) => void;
};

async function waitUntilServing(url: string, token = TOKEN): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      // Each attempt is given its own deadline. A server that accepts the connection and
      // then never answers would otherwise hold this open past the loop's deadline, and
      // "did not start" would arrive as a test timeout with nothing said about why.
      const headers = { authorization: `Bearer ${token}` };
      if ((await fetch(`${url}/api/doc`, { headers, signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`akapen did not start: ${url}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

type Serve = { port: number; origin: string; env: NodeJS.ProcessEnv; stop: () => Promise<void> };

/**
 * `akapen serve` on a port the OS picks, with `home` as its home, once it has printed
 * where it listens. `extra` are the options of `serve`; the document is `add`ed after.
 */
async function startServe(home: string, extra: string[], token: string): Promise<Serve> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AKAPEN_HOME: home,
    AKAPEN_TOKEN: token,
    AKAPEN_MANAGE_TOKEN: '',
    AKAPEN_PORT: '',
    CLAUDE_CODE_SESSION_ID: '',
  };
  const proc: ChildProcess = spawn('bun', ['run', CLI, 'serve', '-p', '0', ...extra], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Taken before anything can fail, so teardown never waits on an exit that already happened.
  const exited = new Promise<void>((done) => proc.once('exit', () => done()));
  /**
   * Waited for, not just signalled. Removing a sandbox while the server is still shutting
   * down leaves it writing into a directory that is going away.
   */
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await exited;
  };
  let out = '';
  proc.stderr?.on('data', (c: Buffer) => (out += c.toString()));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`akapen serve did not start: ${out}`)), 20_000);
      proc.stdout?.on('data', (c: Buffer) => {
        out += c.toString();
        const found = /url\s+http:\/\/[^:]+:(\d+)/.exec(out);
        if (!found) return;
        clearTimeout(timer);
        resolve(Number(found[1]));
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`akapen serve exited with ${code}: ${out}`));
      });
    });
    return { port, origin: `http://127.0.0.1:${port}`, env, stop };
  } catch (err) {
    // The caller never receives a handle when this throws, so nothing else can stop it
    await stop();
    throw err;
  }
}

/** Register `file` with the server and return its URL: `/d/<id>`, no trailing slash, no token. */
function addDocument(serve: Serve, file: string, root?: string): string {
  const added = spawnSync('bun', ['run', CLI, 'add', file, ...(root === undefined ? [] : ['--root', root])], {
    env: { ...serve.env, AKAPEN_PORT: String(serve.port) },
    encoding: 'utf8',
  });
  const url = /^\s+url\s+([^\s?]+)/m.exec(added.stdout)?.[1];
  if (added.status !== 0 || url === undefined) {
    throw new Error(`akapen add exited with ${added.status}: ${added.stderr}${added.stdout}`);
  }
  return url.replace(/\/$/, '');
}

/**
 * Another document, on a server of its own, for the tests that need options of `serve` the
 * fixture does not start with (`--css`, a token other than the common one).
 *
 * Not part of the fixture: only those want one, and every other test would pay for a
 * second process it never looks at. `name` is a file name in a fresh sandbox, or an
 * absolute path to serve an existing file.
 */
export async function startServed(
  home: string,
  name: string,
  {
    extra = [],
    root,
    token = TOKEN,
  }: {
    /** Options of `akapen serve`. */
    extra?: string[];
    /** `akapen add --root`, per document. */
    root?: string;
    /** Another token, for an akapen a tab's cookie does not open. */
    token?: string;
  } = {},
): Promise<{ url: string; origin: string; port: number; stop: () => Promise<void> }> {
  const sandbox = mkdtempSync(join(tmpdir(), 'akapen-e2e-served-'));
  const file = isAbsolute(name) ? name : join(sandbox, name);
  if (!isAbsolute(name)) writeFileSync(file, readFileSync(FIXTURE_MD, 'utf8'));

  let serve: Serve | undefined;
  const stop = async () => {
    await serve?.stop();
    rmSync(sandbox, { recursive: true, force: true });
  };
  try {
    serve = await startServe(home, extra, token);
    const url = addDocument(serve, file, root);
    await waitUntilServing(url, token);
    return { url, origin: serve.origin, port: serve.port, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

export const test = base.extend<{ akapen: Akapen }>({
  akapen: async ({ context }, use) => {
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-e2e-'));
    const file = join(sandbox, 'note.md');
    writeFileSync(file, readFileSync(FIXTURE_MD, 'utf8'));

    const home = join(sandbox, 'home');
    let serve: Serve | undefined;

    // From here on the process may exist, so every exit has to go through the same cleanup.
    // A server that never comes up, or a cookie that will not seed, would otherwise leave
    // a bun process holding the port and a sandbox on disk for the rest of the run.
    try {
      serve = await startServe(home, [], TOKEN);
      const url = addDocument(serve, file);
      await waitUntilServing(url);

      // What a browser holds after one visit to the printed URL. Seeding it here rather
      // than navigating to `?token=` first keeps every test's opening navigation the real
      // one — the bare URL, which is what both a bookmark and a reload are.
      await context.addCookies([{ name: 'akapen_token', value: TOKEN, url: serve.origin }]);

      await use({
        url,
        origin: serve.origin,
        token: TOKEN,
        file,
        home,
        append: (text: string) => writeFileSync(file, readFileSync(file, 'utf8') + text),
      });
    } finally {
      await serve?.stop();
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
});

export { expect } from '@playwright/test';
