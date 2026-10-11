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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const SOURCE = ['# Heading', '', 'A paragraph.', ''].join('\n');

type Started = { lines: string[]; stop: () => void; home: string; file: string };

let running: (() => void)[] = [];
let sandboxes: string[] = [];

afterEach(() => {
  for (const stop of running) stop();
  running = [];
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes = [];
});

/**
 * Start akapen and collect the startup block. `-p 0` by default, so a port someone left
 * listening on cannot fail this, which is also the case the printed port has to survive;
 * `null` passes no `-p`, for the tests of the default port.
 */
async function start(
  extra: string[] = [],
  env: NodeJS.ProcessEnv = {},
  port: string | null = '0',
): Promise<Started> {
  const sandbox = mkdtempSync(join(tmpdir(), 'akapen-startup-'));
  sandboxes.push(sandbox);
  const file = join(sandbox, 'note.md');
  writeFileSync(file, SOURCE);
  const home = join(sandbox, 'home');

  const proc: ChildProcess = spawn(
    'bun',
    ['run', CLI, file, ...(port === null ? [] : ['-p', port]), ...extra],
    {
      env: { ...process.env, AKAPEN_HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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
  return { lines: out.split('\n'), stop, home, file };
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
      // A check that fails to refuse starts a server that never exits; fail rather than hang.
      timeout: 15_000,
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
    // 1, not merely non-zero: a run cut off by the timeout has no status and would pass.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('203.0.113.9');
  }, 30_000);

  it('refuses a hostname, rather than starting and being refused by its own Host check', () => {
    const result = failing(['--host', '0.0.0.0', '--advertise', 'akapen.example.local']);
    // 1, not merely non-zero: a run cut off by the timeout has no status and would pass.
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/hostname/i);
  }, 30_000);

  it('an empty AKAPEN_ADVERTISE is an unset one, not a request to advertise nothing', async () => {
    const { lines } = await start([], { AKAPEN_ADVERTISE: '' });
    expect(urlsIn(lines)[0]).toContain('//127.0.0.1:');
  }, 30_000);

  // #132: these reached Bun.serve, and came back as a stack trace or as "Is port 0 in use?"
  it.each(['[::1', 'not a host', '127.0.0.1:4300', '::1]', 'fe80::1%lo', 'example.com'])(
    'refuses --host %j by name, with the usage, and says nothing about a port',
    (value) => {
      const result = failing(['--host', value]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`akapen: --host`);
      expect(result.stderr).toContain(JSON.stringify(value));
      expect(result.stderr).toContain('akapen <file.md> [options]');
      expect(result.stderr).not.toMatch(/Is port|EADDRINUSE|at startServer/);
    },
    30_000,
  );

  // The other direction: a check that refused everything would pass the one above.
  it.each(['0.0.0.0', '::', '[::]', '127.0.0.1', '::1', '[::1]', 'localhost'])(
    'still starts on --host %s',
    async (value) => {
      const { lines } = await start(['--host', value, '--no-auth']);
      // Answering, not only printing: a bind the Host check then refuses would print fine.
      const [url] = urlsIn(lines);
      expect((await fetch(`${url}/api/doc`)).ok).toBe(true);
    },
    30_000,
  );
});

describe('akapen list --session', () => {
  const SESSION = 'fc40ec79-b629-4c08-9be7-721bb0d306a6';
  const list = (home: string, extra: string[]) =>
    spawnSync('bun', ['run', CLI, 'list', ...extra], {
      env: { ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: '' },
      encoding: 'utf8',
      timeout: 20_000,
    });

  it('takes back the session id its own table printed (#157)', async () => {
    const { home } = await start([], { CLAUDE_CODE_SESSION_ID: SESSION });
    const table = list(home, []);
    const short = /^\d+\s+(\S+)\s/m.exec(table.stdout)?.[1];
    expect(short).toBe(SESSION.slice(0, 8));

    const filtered = list(home, ['--session', short ?? '']);
    expect(filtered.status).toBe(0);
    expect(filtered.stdout).toContain(short);
    expect(filtered.stdout).not.toContain('did not answer');
  }, 30_000);

  it('says nothing running was started by a value no session matches, not that a session has none', async () => {
    const { home } = await start([], { CLAUDE_CODE_SESSION_ID: SESSION });
    const result = list(home, ['--session', '0a1b2c3d']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('no akapen running here was started by a session matching "0a1b2c3d"');
  }, 30_000);

  it('says the akapen did not answer, for a session the registry knows whose instance is silent', () => {
    const home = mkdtempSync(join(tmpdir(), 'akapen-list-'));
    sandboxes.push(home);
    mkdirSync(join(home, 'instances'), { recursive: true });
    // A live pid (this test's own) on a port nothing listens on: registered, never answers.
    const record = {
      pid: process.pid,
      host: '127.0.0.1',
      port: 1,
      file: join(home, 'note.md'),
      startedAt: new Date().toISOString(),
      origin: { kind: 'claude-code', id: SESSION, cwd: home },
    };
    writeFileSync(join(home, 'instances', `${process.pid}.json`), JSON.stringify(record));

    const result = list(home, ['--session', SESSION.slice(0, 8)]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("that session's akapen did not answer");
  }, 30_000);

  it('says no akapen answered, not that none is running, when the registry is not empty (#221)', () => {
    const home = mkdtempSync(join(tmpdir(), 'akapen-list-'));
    sandboxes.push(home);
    mkdirSync(join(home, 'instances'), { recursive: true });
    // A live pid (this test's own) on a port nothing listens on: registered, never answers.
    const record = {
      pid: process.pid,
      host: '127.0.0.1',
      port: 1,
      file: join(home, 'note.md'),
      startedAt: new Date().toISOString(),
    };
    writeFileSync(join(home, 'instances', `${process.pid}.json`), JSON.stringify(record));
    const all = list(home, []);
    expect(all.status).toBe(0);
    expect(all.stdout.trim()).toBe('no akapen answered (1 registered)');
  }, 30_000);
});

/** Hold a port on loopback until released. Resolves with null when it is already taken. */
function hold(port: number): Promise<Server | null> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(null));
    server.listen(port, '127.0.0.1', () => done(server));
  });
}

// #107: the default port moves when taken; a port asked for by name does not.
describe('a taken port', () => {
  it('moves off the default port to one the OS picks, and says so', async () => {
    // Held here, or already taken by something else on the host: either way it is taken.
    const held = await hold(4300);
    try {
      const { lines } = await start(['--no-auth'], {}, null);
      expect(lines.some((line) => /^\s+note\s+port 4300 was taken, so the OS picked \d+$/.test(line))).toBe(
        true,
      );
      const [url] = urlsIn(lines);
      expect(new URL(url!).port).not.toBe('4300');
      expect((await fetch(`${url}/api/doc`)).ok).toBe(true);
    } finally {
      held?.close();
    }
  }, 30_000);

  it('fails on a port asked for by name, with the port in the message and no stack trace', async () => {
    const held = await hold(0);
    const port = (held!.address() as { port: number }).port;
    try {
      const sandbox = mkdtempSync(join(tmpdir(), 'akapen-startup-'));
      sandboxes.push(sandbox);
      const file = join(sandbox, 'note.md');
      writeFileSync(file, SOURCE);
      const result = spawnSync('bun', ['run', CLI, file, '-p', String(port)], {
        env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home') },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`--port ${port} is in use`);
      expect(result.stderr).not.toMatch(/at startServer|Bun v/);
    } finally {
      held?.close();
    }
  }, 30_000);
});

// #130: the other half of `akapen comments`, through the akapen serving the file.
describe('akapen reply and resolve', () => {
  const SESSION = 'fc40ec79-b629-4c08-9be7-721bb0d306a6';
  const cli = (home: string, extra: string[]) =>
    spawnSync('bun', ['run', CLI, ...extra], {
      env: { ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION },
      encoding: 'utf8',
      timeout: 20_000,
    });
  type Thread = {
    id: string;
    resolved: boolean;
    replies: { body: string; authorKind: string; sessionId?: string }[];
  };

  it('replies as the session, resolves, and refuses to resolve twice', async () => {
    const { lines, home, file, stop } = await start(['--no-auth']);
    const [url] = urlsIn(lines);
    const posted = await fetch(`${url}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 1, endLine: 1, body: 'about the heading' }),
    });
    const { comment } = (await posted.json()) as { comment: { id: string } };
    const read = async () =>
      ((await (await fetch(`${url}/api/comments`)).json()) as Thread[]).find((c) => c.id === comment.id)!;

    const replied = cli(home, ['reply', file, comment.id, 'reworded']);
    expect(replied.status).toBe(0);
    expect((await read()).replies).toMatchObject([
      { body: 'reworded', authorKind: 'agent', sessionId: SESSION },
    ]);
    expect((await read()).resolved).toBe(false);

    expect(cli(home, ['resolve', file, comment.id]).status).toBe(0);
    expect((await read()).resolved).toBe(true);

    // The server toggles, so a second resolve would reopen it. Refused instead.
    const again = cli(home, ['resolve', file, comment.id]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already resolved');
    expect((await read()).resolved).toBe(true);

    const unknown = cli(home, ['reply', file, 'no-such-id', 'x']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('no comment no-such-id');

    stop();
    await new Promise((r) => setTimeout(r, 500));
    const nobody = cli(home, ['reply', file, comment.id, 'into the void']);
    expect(nobody.status).toBe(1);
    expect(nobody.stderr).toContain('answered');
  }, 60_000);

  it('reaches an akapen started with --token when given the same --token', async () => {
    const pinned = 'pinned-for-the-reply-test';
    const { lines, home, file } = await start(['--token', pinned]);
    const url = new URL(urlsIn(lines)[0]!).origin;
    const posted = await fetch(`${url}/api/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pinned}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 1, endLine: 1, body: 'x' }),
    });
    const { comment } = (await posted.json()) as { comment: { id: string } };

    expect(cli(home, ['reply', file, comment.id, 'without it']).status).toBe(1);
    const given = cli(home, ['reply', file, comment.id, 'with it', '--token', pinned]);
    expect(given.status).toBe(0);
  }, 60_000);

  it('replies and resolves in one call with --resolve, with auth on', async () => {
    const { lines, home, file } = await start([]);
    const url = new URL(urlsIn(lines)[0]!).origin;
    const auth = { authorization: `Bearer ${readFileSync(join(home, 'token'), 'utf8').trim()}` };
    const posted = await fetch(`${url}/api/comments`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 1, endLine: 1, body: 'x' }),
    });
    const { comment } = (await posted.json()) as { comment: { id: string } };
    const read = async () =>
      ((await (await fetch(`${url}/api/comments`, { headers: auth })).json()) as Thread[]).find(
        (c) => c.id === comment.id,
      )!;

    const done = cli(home, ['reply', file, comment.id, 'fixed', '--resolve']);
    expect(done.status).toBe(0);
    expect((await read()).resolved).toBe(true);
    expect((await read()).replies.map((r) => r.body)).toEqual(['fixed']);

    // Already resolved: the reply still goes, and the resolve is left out rather than reopening it.
    const late = cli(home, ['reply', file, comment.id, 'and one more', '--resolve']);
    expect(late.status).toBe(0);
    expect(late.stdout).toContain('already resolved');
    expect((await read()).resolved).toBe(true);
    expect((await read()).replies.map((r) => r.body)).toEqual(['fixed', 'and one more']);

    // An unquoted text would send only its first word; refused before anything is sent.
    const split = cli(home, ['reply', file, comment.id, 'two', 'words']);
    expect(split.status).toBe(1);
    expect(split.stderr).toContain('unexpected "words"');
    expect((await read()).replies).toHaveLength(2);
  }, 60_000);
});
