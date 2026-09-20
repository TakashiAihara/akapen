/**
 * The startup line, from a real process.
 *
 * The unit tests cover which addresses are chosen; this covers the thing that made it
 * worth doing — that the line printed to the terminal is a URL a browser can open.
 * Nothing short of starting a server and fetching what it printed proves that, and the
 * failure it guards against (`http://0.0.0.0:4300`) is invisible to every other check:
 * the process starts, serves correctly, and prints an address that opens nothing.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const SOURCE = ['# Heading', '', 'A paragraph.', ''].join('\n');

type Started = { lines: string[]; stop: () => void };

let running: (() => void)[] = [];
let sandboxes: string[] = [];

afterEach(() => {
  for (const stop of running) stop();
  running = [];
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes = [];
});

/**
 * Start akapen and collect the startup block. `-p 0` so a port someone left listening
 * on cannot fail this, which is also the case the printed port has to survive.
 */
async function start(extra: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<Started> {
  const sandbox = mkdtempSync(join(tmpdir(), 'akapen-startup-'));
  sandboxes.push(sandbox);
  const file = join(sandbox, 'note.md');
  writeFileSync(file, SOURCE);

  const proc: ChildProcess = spawn('bun', ['run', CLI, file, '-p', '0', ...extra], {
    env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => void proc.kill();
  running.push(stop);

  let out = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  // `store` is the last line of the block for a loopback bind, so waiting for it means
  // every url and also line has already been printed.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`akapen did not start:\n${out}`)), 15_000);
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (!/^\s+store\s+\S/m.test(out)) return;
      clearTimeout(timer);
      resolve();
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`akapen exited with ${code}\n${out}`));
    });
  });
  return { lines: out.split('\n'), stop };
}

const urlsIn = (lines: string[]): string[] =>
  lines.flatMap((line) => /^\s+(?:url|also)\s+(\S+)$/.exec(line)?.slice(1) ?? []);

describe('the startup block', () => {
  it('prints one url for a loopback bind and nothing to choose between', async () => {
    const { lines } = await start();
    const urls = urlsIn(lines);
    expect(urls).toHaveLength(1);
    // The token rides along, because opening the line is the whole of logging in.
    expect(urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    expect(lines.some((line) => /^\s+also\s/.test(line))).toBe(false);
  }, 30_000);

  it('answers on every url it printed for a wildcard bind', async () => {
    // `--no-auth` so the printed line is the bare address: what is under test is which
    // address was chosen, and appending a path to a url carrying a query would test the
    // test rather than the server. That the token is on the line is asserted above.
    const { lines } = await start(['--host', '0.0.0.0', '--no-auth']);
    const urls = urlsIn(lines);
    expect(urls.length).toBeGreaterThan(0);

    // The whole point: what was printed is not the address it was bound to.
    for (const url of urls) expect(url).not.toContain('0.0.0.0');

    // And it is not merely well formed — the server is there.
    for (const url of urls) {
      const res = await fetch(`${url}/api/doc`);
      expect(res.ok).toBe(true);
    }
  }, 30_000);

  it('prints every non-loopback address of the machine, not one picked out of them', async () => {
    const { lines } = await start(['--host', '0.0.0.0', '--no-auth']);
    const printed = urlsIn(lines).map((url) => new URL(url).hostname);
    const expected = Object.values(networkInterfaces())
      .flatMap((infos) => infos ?? [])
      .filter((info) => !info.internal && info.family === 'IPv4')
      .map((info) => info.address);
    // Compared as a set: which one comes first is the default route's business and is
    // settled in the unit tests, where the routing table can be stated rather than read.
    // An isolated container has none, and loopback is the documented fallback there.
    const wanted = expected.length > 0 ? [...new Set(expected)] : ['127.0.0.1'];
    expect(printed.toSorted()).toEqual(wanted.toSorted());
  }, 30_000);

  it('leaves the rest of the block where it was', async () => {
    // The url line moved and grew; round and store did not, and something reads them.
    const { lines } = await start();
    expect(lines.some((line) => /^\s+round\s+\d{3}$/.test(line))).toBe(true);
    expect(lines.some((line) => /^\s+store\s+\S/.test(line))).toBe(true);
  }, 30_000);
});

/**
 * Pinning the address, from a real process.
 *
 * The unit tests state which value is accepted; these cover the two things only a
 * process shows — that the pinned address is what comes out of the printed block with
 * nothing else offered beside it, and that a refused one costs a message rather than a
 * server that is running and cannot be opened.
 */
describe('--advertise', () => {
  /** The machine's own LAN address, or nothing to pin on an isolated container. */
  const lan = Object.values(networkInterfaces())
    .flatMap((infos) => infos ?? [])
    .find((info) => !info.internal && info.family === 'IPv4')?.address;

  const failing = (extra: string[], env: NodeJS.ProcessEnv = {}) => {
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-startup-'));
    sandboxes.push(sandbox);
    const file = join(sandbox, 'note.md');
    writeFileSync(file, SOURCE);
    return spawnSync('bun', ['run', CLI, file, '-p', '0', ...extra], {
      env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home'), ...env },
      encoding: 'utf8',
    });
  };

  it.runIf(lan !== undefined)(
    'prints the pinned address and offers nothing else',
    async () => {
      const { lines } = await start(['--host', '0.0.0.0', '--no-auth', '--advertise', lan!]);
      expect(urlsIn(lines)).toEqual([`http://${lan!}:${String(new URL(urlsIn(lines)[0]!).port)}`]);
      // The reason to pin one is to stop being handed three that cannot work.
      expect(lines.some((line) => /^\s+also\s/.test(line))).toBe(false);
    },
    30_000,
  );

  it.runIf(lan !== undefined)(
    'takes the address from an interface name',
    async () => {
      const name = Object.entries(networkInterfaces()).find(([, infos]) =>
        (infos ?? []).some((info) => info.address === lan),
      )?.[0];
      const { lines } = await start(['--host', '0.0.0.0', '--no-auth', '-A', name!]);
      // The length matters as much as the value: asserting only `[0]` would pass just
      // as well if this form had gone on offering the other addresses beside it.
      expect(urlsIn(lines)).toHaveLength(1);
      expect(urlsIn(lines)[0]).toContain(`//${lan!}:`);
    },
    30_000,
  );

  it.runIf(lan !== undefined)(
    'reads AKAPEN_ADVERTISE, and lets the flag beat it',
    async () => {
      const fromEnv = await start(['--host', '0.0.0.0', '--no-auth'], { AKAPEN_ADVERTISE: lan! });
      expect(urlsIn(fromEnv.lines)).toHaveLength(1);
      expect(urlsIn(fromEnv.lines)[0]).toContain(`//${lan!}:`);

      // Set once per host, so reaching for the flag is what says this run is the exception.
      const overridden = await start(['--host', '0.0.0.0', '--no-auth', '-A', '127.0.0.1'], {
        AKAPEN_ADVERTISE: lan!,
      });
      expect(urlsIn(overridden.lines)).toHaveLength(1);
      expect(urlsIn(overridden.lines)[0]).toContain('//127.0.0.1:');
    },
    60_000,
  );

  it('honours the pinned address even when the bind was concrete', async () => {
    // `urlsFor` prints a concrete bind back without looking at any address list, so
    // handing the pinned one over as that list dropped it: `--host 127.0.0.1 -A
    // localhost` printed `127.0.0.1` and the flag did nothing at all.
    const { lines } = await start(['--host', '127.0.0.1', '--no-auth', '-A', 'localhost']);
    expect(urlsIn(lines)).toHaveLength(1);
    expect(urlsIn(lines)[0]).toContain('//localhost:');
  }, 30_000);

  it('refuses to start on an address this host does not answer to', () => {
    const result = failing(['--host', '127.0.0.1', '--advertise', '203.0.113.9']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('203.0.113.9');
  }, 30_000);

  it('refuses a hostname, rather than starting and being refused by its own Host check', () => {
    const result = failing(['--host', '0.0.0.0', '--advertise', 'akapen.example.local']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/hostname/i);
  }, 30_000);

  it('an empty AKAPEN_ADVERTISE is an unset one, not a request to advertise nothing', async () => {
    const { lines } = await start([], { AKAPEN_ADVERTISE: '' });
    expect(urlsIn(lines)[0]).toContain('//127.0.0.1:');
  }, 30_000);
});

/**
 * The review root (#191): the store line is where the key shows, so it is what proves
 * what `akapen review-root` wrote reached the store.
 */
const storeIn = (lines: string[]): string => /^\s+store\s+(\S+)$/m.exec(lines.join('\n'))![1]!;
const keyed = (input: string): string =>
  `note-${createHash('sha1').update(input).digest('hex').slice(0, 12)}`;
/** A sandbox with a note in it and a store of its own; `cli(...)` runs akapen against that store. */
const sandboxed = () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'akapen-startup-'));
  sandboxes.push(sandbox);
  const file = join(sandbox, 'note.md');
  writeFileSync(file, SOURCE);
  const home = join(sandbox, 'home');
  const cli = (...argv: string[]) =>
    spawnSync('bun', ['run', CLI, ...argv], { env: { ...process.env, AKAPEN_HOME: home }, encoding: 'utf8' });
  return { sandbox, file, home, cli };
};

describe('review-root', () => {
  it('prints none until one is set, then what was set, as a real path', () => {
    const { sandbox, cli } = sandboxed();
    expect(cli('review-root').stdout.trim()).toBe('none');
    expect(cli('review-root', sandbox).stdout.trim()).toBe(realpathSync(sandbox));
    expect(cli('review-root').stdout.trim()).toBe(realpathSync(sandbox));
    expect(cli('review-root', '--clear').status).toBe(0);
    expect(cli('review-root').stdout.trim()).toBe('none');
  }, 60_000);

  it('keys the served file by its path relative to the root', async () => {
    const { sandbox, home, cli } = sandboxed();
    expect(cli('review-root', tmpdir()).status).toBe(0);
    const { lines } = await start([], { AKAPEN_HOME: home });
    // The sandbox `start` made is a sibling of this one under tmpdir, so the key is
    // `<its name>/note.md`; the absolute key would not end this way.
    const rel = relative(realpathSync(tmpdir()), realpathSync(join(sandboxes.at(-1)!, 'note.md')));
    expect(sandboxes.at(-1)).not.toBe(sandbox);
    expect(storeIn(lines).endsWith(keyed(rel))).toBe(true);
  }, 30_000);

  it('refuses a root that is not a directory, rather than storing it', () => {
    const { file, cli } = sandboxed();
    const result = cli('review-root', file);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${file} is not a directory`);
    expect(cli('review-root').stdout.trim()).toBe('none');
  }, 30_000);

  it('refuses two directories rather than keeping the first', () => {
    const { sandbox, cli } = sandboxed();
    const result = cli('review-root', sandbox, tmpdir());
    expect(result.status).not.toBe(0);
    expect(cli('review-root').stdout.trim()).toBe('none');
  }, 30_000);

  it('stops comments and serving on a root that has gone missing, and leaves list alone', () => {
    const { sandbox, file, cli } = sandboxed();
    const gone = join(sandbox, 'gone');
    mkdirSync(gone);
    expect(cli('review-root', gone).status).toBe(0);
    rmSync(gone, { recursive: true });
    // The file exists, so a check that merely fell through would print `[]` with status 0.
    const comments = cli('comments', file);
    expect(comments.status).not.toBe(0);
    expect(comments.stderr).toContain('is not a directory');
    const serve = cli(file, '-p', '0');
    expect(serve.status).not.toBe(0);
    expect(serve.stderr).toContain('is not a directory');
    const list = cli('list');
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('no akapen is running');
  }, 30_000);
});

/**
 * Two stores for one note (#191): this host reviewed it before the root was set, and
 * the other host's store arrived by sync under the relative key. Neither is dropped,
 * and the one nothing looks up is named.
 */
describe('a legacy store left behind', () => {
  /** A note under a root, with a review under the absolute key and one under the relative key. */
  const twoStores = () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-startup-'));
    sandboxes.push(sandbox);
    const root = join(sandbox, 'notes');
    mkdirSync(root);
    const file = join(root, 'note.md');
    writeFileSync(file, SOURCE);
    const home = join(sandbox, 'home');
    const key = (input: string) => join(home, 'reviews', keyed(input));
    // The absolute key is the path as given (`resolve`), not its realpath. Each store
    // holds a comment of its own, so which one was read shows in the output.
    for (const [dir, body] of [
      [key(file), 'from the legacy store'],
      [key('note.md'), 'from the relative store'],
    ] as const) {
      mkdirSync(join(dir, 'rounds', '001'), { recursive: true });
      writeFileSync(join(dir, 'rounds', '001', 'content.md'), SOURCE);
      writeFileSync(
        join(dir, 'rounds', '001', 'comments.json'),
        JSON.stringify([
          {
            id: 'c_1',
            startLine: 1,
            endLine: 1,
            body,
            author: 't',
            createdAt: 'x',
            resolved: false,
            anchor: '# Heading',
            replies: [],
          },
        ]),
      );
      writeFileSync(
        join(dir, 'review.json'),
        JSON.stringify({ version: 2, currentRound: 1, rounds: [{ n: 1, createdAt: 'x', closedAt: null }] }),
      );
    }
    return { file, root, home, legacy: key(file) };
  };

  it('is named in the startup block', async () => {
    const { file, root, home, legacy } = twoStores();
    expect(
      spawnSync('bun', ['run', CLI, 'review-root', root], { env: { ...process.env, AKAPEN_HOME: home } })
        .status,
    ).toBe(0);
    const proc = spawn('bun', ['run', CLI, file, '-p', '0'], {
      env: { ...process.env, AKAPEN_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.push(() => void proc.kill());
    let out = '';
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`akapen did not start:\n${out}`)), 15_000);
      proc.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        if (!/^\s+store\s+\S/m.test(out)) return;
        clearTimeout(timer);
        resolve();
      });
    });
    expect(out).toContain(`legacy  ${legacy}`);
  }, 30_000);

  it('is named on stderr by comments, with the JSON on stdout untouched', () => {
    const { file, root, home, legacy } = twoStores();
    expect(
      spawnSync('bun', ['run', CLI, 'review-root', root], { env: { ...process.env, AKAPEN_HOME: home } })
        .status,
    ).toBe(0);
    const result = spawnSync('bun', ['run', CLI, 'comments', file], {
      env: { ...process.env, AKAPEN_HOME: home },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as { body: string }[]).map((c) => c.body)).toEqual([
      'from the relative store',
    ]);
    expect(result.stderr).toContain(legacy);
  }, 30_000);
});
