/**
 * The startup line of `akapen serve`, and the commands that talk to it, from real processes.
 *
 * The unit tests cover which addresses are chosen; this covers the thing that made it
 * worth doing — that the line printed to the terminal is a URL a browser can open.
 * Nothing short of starting a server and fetching what it printed proves that, and the
 * failure it guards against (`http://0.0.0.0:4300`) is invisible to every other check:
 * the process starts, serves correctly, and prints an address that opens nothing.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const SOURCE = ['# Heading', '', 'A paragraph.', ''].join('\n');

type Started = {
  /** What `akapen serve` printed on startup. */
  lines: string[];
  stop: () => void;
  home: string;
  file: string;
  port: string;
  /** The registered document, with a trailing slash and no token: `http://host:port/d/<id>/`. */
  doc: string;
};

let running: (() => void)[] = [];
let sandboxes: string[] = [];

afterEach(() => {
  for (const stop of running) stop();
  running = [];
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes = [];
});

/**
 * Start `akapen serve` and register a note with it, collecting the startup block. `-p 0`,
 * so a port someone left listening on cannot fail this, which is also the case the printed
 * port has to survive. `env` goes to both commands; a `--token` among the options is given
 * to `add` as well, since a server that requires one refuses it without.
 */
async function start(extra: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<Started> {
  const sandbox = mkdtempSync(join(tmpdir(), 'akapen-startup-'));
  sandboxes.push(sandbox);
  const file = join(sandbox, 'note.md');
  writeFileSync(file, SOURCE);
  const home = join(sandbox, 'home');
  const environment = { ...process.env, AKAPEN_HOME: home, AKAPEN_PORT: '', ...env };

  const proc: ChildProcess = spawn('bun', ['run', CLI, 'serve', '-p', '0', ...extra], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => void proc.kill();
  running.push(stop);

  let out = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  // The `url` line is the last one of the block for an open server, so waiting for it
  // means the whole block has been printed.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`akapen did not start:\n${out}`)), 15_000);
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (!/^\s+url\s+\S/m.test(out)) return;
      clearTimeout(timer);
      resolve();
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`akapen exited with ${code}\n${out}`));
    });
  });
  const url = urlsIn(out.split('\n'))[0]!;
  const port = new URL(url).port;
  const token = extra.indexOf('--token');
  const added = spawnSync(
    'bun',
    ['run', CLI, 'add', file, ...(token === -1 ? [] : ['--token', extra[token + 1]!])],
    { env: { ...environment, AKAPEN_PORT: port }, encoding: 'utf8', timeout: 20_000 },
  );
  const doc = /^\s+url\s+([^\s?]+)/m.exec(added.stdout)?.[1];
  if (added.status !== 0 || doc === undefined) {
    throw new Error(`akapen add exited with ${added.status}\n${added.stderr}${added.stdout}`);
  }
  return { lines: out.split('\n'), stop, home, file, port, doc };
}

/** Whether `::1` can be bound here, found by binding it rather than by guessing from the platform. */
const ipv6Bindable = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});

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

  it('answers on the url it printed for a wildcard bind, and on the document it handed out', async () => {
    // `--no-auth` so the printed line is the bare address: what is under test is which
    // address was chosen, and appending a path to a url carrying a query would test the
    // test rather than the server. That the token is on the line is asserted above.
    const { lines, doc } = await start(['--host', '0.0.0.0', '--no-auth']);
    const urls = urlsIn(lines);
    expect(urls).toHaveLength(1);

    // The whole point: what was printed is not the address it was bound to.
    expect(urls[0]).not.toContain('0.0.0.0');
    expect(doc).not.toContain('0.0.0.0');

    // And it is not merely well formed — the server is there.
    expect((await fetch(`${urls[0]}/`)).ok).toBe(true);
    expect((await fetch(`${doc}api/doc`)).ok).toBe(true);
  }, 30_000);

  it('says what it is, ahead of the url', async () => {
    const { lines } = await start();
    expect(lines[0]).toBe('akapen serve');
    expect(lines.findIndex((line) => /^\s+url\s/.test(line))).toBe(1);
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
    return spawnSync('bun', ['run', CLI, 'serve', '-p', '0', ...extra], {
      env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home'), AKAPEN_PORT: '', ...env },
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
      expect(result.stderr).toContain('akapen serve [options]');
      expect(result.stderr).not.toMatch(/Is port|EADDRINUSE|at startDaemon/);
    },
    30_000,
  );

  // The other direction: a check that refused everything would pass the one above.
  const startsOn = async (value: string) => {
    const { doc } = await start(['--host', value, '--no-auth']);
    // Answering, not only printing: a bind the Host check then refuses would print fine.
    expect((await fetch(`${doc}api/doc`)).ok).toBe(true);
  };

  it.each(['0.0.0.0', '127.0.0.1'])('still starts on --host %s', startsOn, 30_000);

  // The CLI reaches the server on 127.0.0.1, so a bind it could not reach there is refused
  // by name instead of starting a server nothing can register a document with.
  it.each(['localhost', '::1', '[::1]'])(
    'refuses --host %s, which the CLI on this machine could not reach',
    (value) => {
      const result = failing(['--host', value]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unable to reach it');
    },
    30_000,
  );

  // Skipped only off CI: a CI runner that lost IPv6 has to fail here, not drop the check.
  it.skipIf(!ipv6Bindable && !process.env['CI']).each(['::'])(
    'still starts on --host %s',
    async (value) => {
      expect(ipv6Bindable, 'this host cannot bind IPv6').toBe(true);
      await startsOn(value);
    },
    30_000,
  );
});

describe('akapen list --session', () => {
  const SESSION = 'fc40ec79-b629-4c08-9be7-721bb0d306a6';
  const list = (home: string, extra: string[]) =>
    spawnSync('bun', ['run', CLI, 'list', ...extra], {
      env: { ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: '', AKAPEN_PORT: '' },
      encoding: 'utf8',
      timeout: 20_000,
    });

  it('takes back the session id its own table printed (#157)', async () => {
    const { home, port } = await start([], { CLAUDE_CODE_SESSION_ID: SESSION });
    const table = list(home, []);
    const short = /^serve\s+(\S+)\s/m.exec(table.stdout)?.[1];
    expect(short).toBe(SESSION.slice(0, 8));

    const filtered = list(home, ['--session', short ?? '']);
    expect(filtered.status).toBe(0);
    expect(filtered.stdout).toContain(short);
    expect(filtered.stdout).toContain(`:${port}/d/note-`);
  }, 30_000);

  it('says no registered document belongs to a value no session matches, not that a session has none', async () => {
    const { home } = await start([], { CLAUDE_CODE_SESSION_ID: SESSION });
    const result = list(home, ['--session', '0a1b2c3d']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      'no document registered with akapen serve belongs to a session matching "0a1b2c3d"',
    );
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

// A moved port is a changed URL, so a port that is taken is a failure, not a move.
describe('a taken port', () => {
  it('fails on a port asked for by name, with the port in the message and no stack trace', async () => {
    const held = await hold(0);
    const port = (held!.address() as { port: number }).port;
    try {
      const sandbox = mkdtempSync(join(tmpdir(), 'akapen-startup-'));
      sandboxes.push(sandbox);
      const result = spawnSync('bun', ['run', CLI, 'serve', '-p', String(port)], {
        env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home'), AKAPEN_PORT: '' },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`port ${port} is in use`);
      expect(result.stderr).not.toMatch(/at startDaemon|Bun v/);
    } finally {
      held?.close();
    }
  }, 30_000);
});

/** What a stand-in for akapen serve answers with: the CLI sends nothing to a listener without the marker. */
const AS_SERVE = { 'content-type': 'application/json', 'x-akapen-serve': '1' };

/** A 200 answer with `body` as JSON, for the fake akapen in the resolve tests. */
const json = (body: unknown): [number, string] => [200, JSON.stringify(body)];

/**
 * What a request to the server on `port` answers, for a stand-in that sits in front of it:
 * the request as the CLI made it, headers and management secret included.
 */
async function relay(port: string, req: IncomingMessage): Promise<{ status: number; body: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!['host', 'connection', 'content-length'].includes(name)) headers[name] = String(value);
  }
  const answer = await fetch(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method ?? 'GET',
    headers,
    redirect: 'manual',
    ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
  });
  return { status: answer.status, body: await answer.text() };
}

/**
 * The CLI run without blocking this process, for a test whose stand-in server lives in it
 * and has to answer while the CLI waits.
 */
async function runCli(
  home: string,
  port: string,
  session: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn('bun', ['run', CLI, ...args], {
    env: { ...process.env, AKAPEN_HOME: home, AKAPEN_PORT: port, CLAUDE_CODE_SESSION_ID: session },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const status = await new Promise<number | null>((r) => child.on('close', r));
  return { status, stdout, stderr };
}

// #130: the other half of `akapen comments`, through `akapen serve`.
describe('akapen reply and resolve', () => {
  const SESSION = 'fc40ec79-b629-4c08-9be7-721bb0d306a6';
  const cli = (home: string, extra: string[]) =>
    spawnSync('bun', ['run', CLI, ...extra], {
      env: { ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION, AKAPEN_PORT: '' },
      encoding: 'utf8',
      timeout: 20_000,
    });
  type Thread = {
    id: string;
    resolved: boolean;
    replies: { body: string; authorKind: string; sessionId?: string }[];
  };

  it('replies as the session, resolves, and refuses to resolve twice', async () => {
    const { doc, home, file, stop } = await start(['--no-auth']);
    const url = doc.slice(0, -1);
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

    const resolved = cli(home, ['resolve', file, comment.id]);
    expect(resolved.status).toBe(0);
    expect(resolved.stdout.trim()).toBe('resolved');
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
    expect(nobody.stderr).toContain('akapen serve is not answering');
    expect(nobody.stderr).toContain('so nothing was written');
  }, 60_000);

  it('cuts a round, and exits 1 when nothing serves the file or the server refuses (#178)', async () => {
    const { doc, home, file, stop } = await start(['--no-auth']);
    const url = doc.slice(0, -1);
    const current = async () =>
      ((await (await fetch(`${url}/api/rounds`)).json()) as { current: number }).current;
    expect(await current()).toBe(1);

    writeFileSync(file, `${SOURCE}\nan edit\n`);
    const cut = cli(home, ['rounds', 'cut', file]);
    expect(cut.status).toBe(0);
    expect(cut.stdout.trim()).toBe('round 2 is now current');
    expect(await current()).toBe(2);
    // Nothing changed since, so the round just opened is still the one to read (#110).
    const unchanged = cli(home, ['rounds', 'cut', file]);
    expect(unchanged.status).toBe(0);
    expect(unchanged.stdout.trim()).toBe('round 2 is now current');
    expect(await current()).toBe(2);
    writeFileSync(file, `${SOURCE}\nan edit\nanother\n`);
    const second = cli(home, ['rounds', 'cut', file]);
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe('round 3 is now current');
    expect(await current()).toBe(3);

    const misspelt = cli(home, ['rounds', 'cutt', file]);
    expect(misspelt.status).toBe(1);
    expect(misspelt.stderr).toContain('unknown subcommand "cutt"');
    expect(await current()).toBe(3);

    const missing = cli(home, ['rounds', 'cut', `${file}.absent`]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('no such file');
    const noFile = cli(home, ['rounds', 'cut']);
    expect(noFile.status).toBe(1);
    expect(noFile.stderr).toContain('no such file: (missing)');
    expect(await current()).toBe(3);

    const extra = cli(home, ['rounds', 'cut', file, 'again']);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain('unexpected "again"');
    expect(await current()).toBe(3);

    // The server refuses a cut of an emptied file; that is the CLI's failure too.
    writeFileSync(file, '');
    const refused = cli(home, ['rounds', 'cut', file]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('answered 409');
    expect(await current()).toBe(3);

    stop();
    await new Promise((r) => setTimeout(r, 500));
    const nobody = cli(home, ['rounds', 'cut', file]);
    expect(nobody.status).toBe(1);
    expect(nobody.stderr).toContain('akapen serve is not answering');
    expect(nobody.stderr).toContain('so nothing was written');
  }, 60_000);

  it('cuts a round on an akapen that requires a token, given the same --token (#178)', async () => {
    const pinned = 'pinned-for-the-cut-test';
    const { doc, home, file } = await start(['--token', pinned]);
    const url = doc.slice(0, -1);
    const current = async () =>
      (
        (await (
          await fetch(`${url}/api/rounds`, { headers: { authorization: `Bearer ${pinned}` } })
        ).json()) as {
          current: number;
        }
      ).current;
    expect(await current()).toBe(1);

    writeFileSync(file, `${SOURCE}\nan edit\n`);
    const without = cli(home, ['rounds', 'cut', file]);
    expect(without.status).toBe(1);
    expect(await current()).toBe(1);

    const given = cli(home, ['rounds', 'cut', file, '--token', pinned]);
    expect(given.status).toBe(0);
    expect(given.stdout.trim()).toBe('round 2 is now current');
    expect(await current()).toBe(2);
  }, 60_000);

  it('says who spoke last on the thread (#249)', async () => {
    const { doc, home, file } = await start(['--no-auth']);
    const url = doc.slice(0, -1);
    const posted = await fetch(`${url}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 1, endLine: 1, body: 'about the heading' }),
    });
    const { comment } = (await posted.json()) as { comment: { id: string } };
    const last = () =>
      (JSON.parse(cli(home, ['comments', file]).stdout) as { last_author_kind: string }[])[0]!
        .last_author_kind;
    const personReplies = async () => {
      const res = await fetch(`${url}/api/comments/${comment.id}/replies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'from a person' }),
      });
      expect(res.ok).toBe(true);
    };

    // Stored comments from before replies existed have no such key.
    const stored = readdirSync(join(home, 'comments'), { recursive: true, encoding: 'utf8' }).find((p) =>
      p.endsWith('comments.json'),
    )!;
    const path = join(home, 'comments', stored);
    const original = readFileSync(path, 'utf8');
    const bare = JSON.parse(original) as Record<string, unknown>[];
    for (const c of bare) delete c['replies'];
    writeFileSync(path, JSON.stringify(bare));
    expect(last()).toBe('human');
    writeFileSync(path, original);

    expect(last()).toBe('human');
    await personReplies();
    expect(last()).toBe('human');
    expect(cli(home, ['reply', file, comment.id, 'from the agent']).status).toBe(0);
    expect(last()).toBe('agent');
    await personReplies();
    expect(last()).toBe('human');
  }, 60_000);

  it('reaches an akapen started with --token when given the same --token', async () => {
    const pinned = 'pinned-for-the-reply-test';
    const { doc, home, file } = await start(['--token', pinned]);
    const url = doc.slice(0, -1);
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
    const { doc, home, file } = await start([]);
    const url = doc.slice(0, -1);
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

  // #245: the rest of what #231 fixed without a test.
  it('finds the file from another directory, says whose the reply is, and refuses a resolve with a text', async () => {
    const { doc, home, file } = await start(['--no-auth']);
    const url = doc.slice(0, -1);
    const posted = await fetch(`${url}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 1, endLine: 1, body: 'x' }),
    });
    const { comment } = (await posted.json()) as { comment: { id: string } };
    const read = async () =>
      ((await (await fetch(`${url}/api/comments`)).json()) as Thread[]).find((c) => c.id === comment.id)!;
    const run = (cwd: string, session: string | undefined, extra: string[]) => {
      // The server this home recorded, not one an AKAPEN_PORT exported by the runner names.
      const env: NodeJS.ProcessEnv = { ...process.env, AKAPEN_HOME: home, AKAPEN_PORT: '' };
      if (session === undefined) delete env['CLAUDE_CODE_SESSION_ID'];
      else env['CLAUDE_CODE_SESSION_ID'] = session;
      return spawnSync('bun', ['run', CLI, ...extra], { cwd, env, encoding: 'utf8', timeout: 20_000 });
    };

    // A relative name from the file's own directory names the same document.
    const dir = join(file, '..');
    const name = file.slice(dir.length + 1);
    const asAgent = run(dir, SESSION, ['reply', name, comment.id, 'from the agent']);
    expect(asAgent.status).toBe(0);
    expect(asAgent.stdout.trim()).toBe('replied (filed as the agent)');
    const asPerson = run(dir, undefined, ['reply', name, comment.id, 'from a person']);
    expect(asPerson.status).toBe(0);
    expect(asPerson.stdout.trim()).toBe('replied (filed as a person, no CLAUDE_CODE_SESSION_ID)');
    expect((await read()).replies).toMatchObject([
      { body: 'from the agent', authorKind: 'agent', sessionId: SESSION },
      { body: 'from a person', authorKind: 'human' },
    ]);
    expect((await read()).replies[1]).not.toHaveProperty('sessionId');

    const withText = cli(home, ['resolve', file, comment.id, 'done']);
    expect(withText.status).toBe(1);
    expect(withText.stderr).toContain('resolve: unexpected "done"');
    expect((await read()).resolved).toBe(false);
  }, 60_000);

  it('resolves again when someone resolved the comment since it was read, rather than leave it reopened (#245)', async () => {
    const { doc, home, file, port } = await start(['--no-auth']);
    const url = doc.slice(0, -1);
    const posted = await fetch(`${url}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 1, endLine: 1, body: 'x' }),
    });
    const { comment } = (await posted.json()) as { comment: { id: string } };
    const read = async () =>
      ((await (await fetch(`${url}/api/comments`)).json()) as Thread[]).find((c) => c.id === comment.id)!;

    const second = await fetch(`${url}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 1, endLine: 1, body: 'y' }),
    });
    const other = ((await second.json()) as { comment: { id: string } }).comment;

    // In front of the server, so someone can resolve a comment in the page right after the
    // CLI has read it and before its resolve lands. The read is answered as it was.
    const resolvedAfterRead: string[] = [];
    const proxy = createHttpServer((req, res) => {
      void relay(port, req).then(async ({ status, body }) => {
        if (req.url?.includes('/api/pending')) {
          for (const id of resolvedAfterRead.splice(0)) {
            await fetch(`${url}/api/comments/${id}/resolve`, { method: 'POST' });
          }
        }
        res.writeHead(status, AS_SERVE).end(body);
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyPort = String((proxy.address() as { port: number }).port);
    try {
      resolvedAfterRead.push(comment.id);
      const raced = await runCli(home, proxyPort, SESSION, ['resolve', file, comment.id]);
      expect(raced.status).toBe(0);
      expect(raced.stdout.trim()).toBe('resolved (someone resolved it meanwhile, and this toggled it back)');
      expect((await read()).resolved).toBe(true);

      // The same through reply --resolve: the reply goes, and the resolve is toggled back.
      resolvedAfterRead.push(other.id);
      const replied = await runCli(home, proxyPort, SESSION, ['reply', file, other.id, 'done', '--resolve']);
      expect(replied.status).toBe(0);
      expect(replied.stdout.trim().split('\n')).toEqual([
        'replied (filed as the agent)',
        'resolved (someone resolved it meanwhile, and this toggled it back)',
      ]);
      const after = ((await (await fetch(`${url}/api/comments`)).json()) as Thread[]).find(
        (c) => c.id === other.id,
      )!;
      expect(after.resolved).toBe(true);
      expect(after.replies.map((r) => r.body)).toEqual(['done']);
    } finally {
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
    }
  }, 60_000);

  it('exits 1 on a resolve that does not end resolved, after one retry at most, and on a reply never answered (#245)', async () => {
    const { doc, home, file, port } = await start(['--no-auth']);
    const url = doc.slice(0, -1);
    const posted = await fetch(`${url}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 1, endLine: 1, body: 'x' }),
    });
    const { comment } = (await posted.json()) as { comment: { id: string } };

    // Answers the listing and the comments as the real server does, and the nth resolve
    // (from 1) as `answer` says.
    let resolves = 0;
    let answer: (n: number) => [number, string] = () => json({ comment: { id: comment.id } });
    let replyAnswer: [number, string] | null = null;
    let replies = 0;
    const fake = createHttpServer((req, res) => {
      if (req.url?.startsWith('/api/documents') || req.url?.includes('/api/pending')) {
        void relay(port, req).then(({ status, body }) => res.writeHead(status, AS_SERVE).end(body));
        return;
      }
      // Unanswered unless set, to see the CLI give up rather than wait on it.
      if (req.url?.endsWith('/replies')) {
        replies++;
        if (replyAnswer) res.writeHead(replyAnswer[0], AS_SERVE).end(replyAnswer[1]);
        return;
      }
      const [status, body] = answer(++resolves);
      res.writeHead(status, AS_SERVE).end(body);
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = String((fake.address() as { port: number }).port);
    try {
      // Not spawnSync: the fake runs in this process and has to answer while the CLI waits.
      const run = (extra: string[]) => runCli(home, fakePort, SESSION, extra);
      const odd = await run(['resolve', file, comment.id]);
      expect(odd.status).toBe(1);
      expect(odd.stderr).toContain(`the resolve of ${comment.id} answered without its state`);
      expect(resolves).toBe(1);

      // A null and a body that is not JSON end the same way, rather than as a stack trace.
      for (const [body, said] of [
        ['null', `the resolve of ${comment.id} answered without its state`],
        ['<html>', 'answered 200 with a body that is not JSON'],
      ] as const) {
        answer = () => [200, body];
        resolves = 0;
        const bad = await run(['resolve', file, comment.id]);
        expect(bad.status).toBe(1);
        expect(bad.stderr).toContain(said);
        expect(bad.stderr).not.toMatch(/TypeError|SyntaxError|\n\s+at /);
        expect(resolves).toBe(1);
      }

      // Reopened, and the toggle back answers with no state: the reopening is still said.
      answer = (n) => json({ comment: n === 1 ? { id: comment.id, resolved: false } : { id: comment.id } });
      resolves = 0;
      const blank = await run(['resolve', file, comment.id]);
      expect(blank.status).toBe(1);
      expect(blank.stderr).toContain(
        `reopened ${comment.id}, which someone had resolved meanwhile, and the toggle back answered without its state`,
      );
      expect(resolves).toBe(2);

      // Open after the call back too: toggled back once, not until it comes back resolved.
      answer = () => json({ comment: { id: comment.id, resolved: false } });
      resolves = 0;
      const stuck = await run(['resolve', file, comment.id]);
      expect(stuck.status).toBe(1);
      expect(stuck.stderr).toContain(
        `reopened ${comment.id}, which someone had resolved meanwhile, and the toggle back left it open`,
      );
      expect(resolves).toBe(2);

      // The toggle back fails: what is said is that this call left it open.
      answer = (n) => (n === 1 ? json({ comment: { id: comment.id, resolved: false } }) : [500, 'broken']);
      resolves = 0;
      const broken = await run(['resolve', file, comment.id]);
      expect(broken.status).toBe(1);
      expect(broken.stderr).toContain(
        `reopened ${comment.id}, which someone had resolved meanwhile, and the toggle back /api/comments/`,
      );
      expect(resolves).toBe(2);

      // reply --resolve: the reply landed, and the failure says so, so it is not sent twice.
      replyAnswer = json({ comment: { id: comment.id } });
      answer = () => [500, 'broken'];
      resolves = 0;
      replies = 0;
      const halfway = await run(['reply', file, comment.id, 'landed', '--resolve']);
      expect(halfway.status).toBe(1);
      expect(halfway.stderr).toContain(`replied, but /api/comments/${comment.id}/resolve answered 500`);
      expect(resolves).toBe(1);
      expect(replies).toBe(1);
      replyAnswer = null;

      const began = Date.now();
      const silent = await run(['reply', file, comment.id, 'into silence']);
      expect(silent.status).toBe(1);
      expect(silent.stderr).toContain('/replies did not answer (TimeoutError)');
      const waited = Date.now() - began;
      expect(waited).toBeGreaterThanOrEqual(9_000);
      expect(waited).toBeLessThan(18_000);
    } finally {
      fake.closeAllConnections();
      await new Promise((r) => fake.close(r));
    }
  }, 60_000);
});
