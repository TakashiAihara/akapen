/**
 * `akapen serve`: one process serving every registered document under `/d/<id>/` (#305).
 *
 * Spawned, as server.test.ts does, so the path under test is the one the binary takes.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localAddresses } from '@akapen/core/addresses';

const TOKEN = 'test-token-for-the-daemon-suite';
const CLI = join(import.meta.dirname, '..', '..', 'cli', 'src', 'cli.ts');

const authed = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${TOKEN}` },
  });

type Daemon = { port: string; base: string; stop: () => Promise<void> };

let sandbox: string;
let home: string;
let running: Daemon[] = [];

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: '',
  AKAPEN_HOME: home,
  AKAPEN_TOKEN: TOKEN,
  ...extra,
});

async function serve(args: string[] = []): Promise<Daemon> {
  const proc: ChildProcess = spawn('bun', ['run', CLI, 'serve', '-p', '0', ...args], {
    env: env(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Before anything can fail, so a server that never prints its URL is still stopped.
  const exited = new Promise<void>((done) => proc.on('exit', () => done()));
  const kill = async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await exited;
  };
  let out = '';
  proc.stderr?.on('data', (c: Buffer) => (out += c.toString()));
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`akapen serve did not start:\n${out}`)), 15_000);
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
      const found = /url\s+http:\/\/[^:]+:(\d+)/.exec(out);
      if (!found) return;
      clearTimeout(timer);
      resolve(found[1]!);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`akapen serve exited with ${code}\n${out}`));
    });
  }).catch(async (err: unknown) => {
    await kill();
    throw err;
  });
  const daemon: Daemon = { port, base: `http://127.0.0.1:${port}`, stop: kill };
  running.push(daemon);
  return daemon;
}

/** The CLI, pointed at the daemon by `AKAPEN_PORT` as a real caller is. */
function cli(d: Daemon | null, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('bun', ['run', CLI, ...args], {
    env: env({ AKAPEN_PORT: d?.port ?? '1', ...extra }),
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const urlIn = (out: string): string => /url\s+(\S+)\?token=/.exec(out)![1]!;

async function until(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const comment = (url: string, body: string) =>
  authed(`${url}api/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startLine: 1, endLine: 1, body }),
  });

function note(rel: string, text = '# A heading\n\nA paragraph.\n'): string {
  const path = join(sandbox, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'akapen-daemon-'));
  home = join(sandbox, 'home');
});

afterEach(async () => {
  await Promise.all(running.map((d) => d.stop()));
  running = [];
  rmSync(sandbox, { recursive: true, force: true });
});

describe('akapen serve', () => {
  it('hands out the same URL for the same path, and another for the same name elsewhere', async () => {
    const d = await serve();
    const a = note('one/note.md');
    const b = note('two/note.md');

    const first = cli(d, ['add', a]);
    expect(first.code, first.err).toBe(0);
    const again = cli(d, ['add', a]);
    const other = cli(d, ['add', b]);

    expect(urlIn(first.out)).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${d.port}/d/note-[0-9a-f]{12}/$`));
    expect(urlIn(again.out)).toBe(urlIn(first.out));
    expect(urlIn(other.out)).not.toBe(urlIn(first.out));
    const registered = JSON.parse(readFileSync(join(home, 'documents.json'), 'utf8')) as {
      documents: unknown[];
    };
    expect(registered.documents).toHaveLength(2);
  });

  it('serves the page and the API under the document path, and files comments in its store', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);

    const page = await authed(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<header class="topbar"');
    expect(((await (await authed(`${url}api/status`)).json()) as { title: string }).title).toBe('A heading');

    const posted = await authed(`${url}api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 3, endLine: 3, body: 'through the daemon' }),
    });
    expect(posted.status).toBe(200);
    const comments = JSON.parse(cli(d, ['comments', file]).out) as { body: string }[];
    expect(comments.map((c) => c.body)).toEqual(['through the daemon']);
  });

  it('redirects the path without its slash, so the page asks its own routes', async () => {
    const d = await serve();
    const url = urlIn(cli(d, ['add', note('note.md')]).out);
    const res = await authed(url.slice(0, -1), { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(new URL(url).pathname);
    const withQuery = await authed(`${url.slice(0, -1)}?round=1`, { redirect: 'manual' });
    expect(withQuery.headers.get('location')).toBe(`${new URL(url).pathname}?round=1`);
  });

  it('says the server is running when nothing is registered', async () => {
    const d = await serve();
    const r = cli(d, ['list']);
    expect(r.out).toContain(`akapen serve is running on port ${d.port}; nothing is registered`);
  });

  it('listens on 4300 or AKAPEN_PORT rather than the port a crashed server recorded', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'serve.json'), JSON.stringify({ port: 1, pid: 1 }));
    const proc = spawn('bun', ['run', CLI, 'serve'], {
      env: env({ AKAPEN_PORT: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<void>((done) => proc.on('exit', () => done()));
    try {
      let out = '';
      await until(() => {
        out += proc.stdout.read()?.toString() ?? '';
        return /url\s+http/.test(out);
      }, 15_000);
      expect(out).not.toMatch(/:1\//);
    } finally {
      proc.kill();
      await exited;
    }
  });

  it('does not take the server of another home for its own', async () => {
    const d = await serve();
    cli(d, ['add', note('note.md')]);
    const r = spawnSync('bun', ['run', CLI, 'list'], {
      env: { ...env(), AKAPEN_HOME: join(sandbox, 'other-home'), AKAPEN_PORT: '' },
      encoding: 'utf8',
    });
    expect(r.stdout.trim()).toBe('no akapen is running');
  });

  it('listens on AKAPEN_PORT over the port a crashed server recorded', async () => {
    mkdirSync(home, { recursive: true });
    const free = await new Promise<number>((done) => {
      const s = createNetServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => done(p));
      });
    });
    writeFileSync(join(home, 'serve.json'), JSON.stringify({ port: 1, pid: 1 }));
    const proc = spawn('bun', ['run', CLI, 'serve'], {
      env: env({ AKAPEN_PORT: String(free) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<void>((done) => proc.on('exit', () => done()));
    try {
      let out = '';
      await until(() => {
        out += proc.stdout.read()?.toString() ?? '';
        return /url\s+http/.test(out);
      }, 15_000);
      expect(out).toContain(`127.0.0.1:${free}/`);
    } finally {
      proc.kill();
      await exited;
    }
  });

  it('says a server on another token is running, and a one-document start refuses beside it', async () => {
    const d = await serve();
    const other = { AKAPEN_TOKEN: 'some-other-token' };
    expect(cli(d, ['list'], other).out).toContain('refused this token');
    const r = spawnSync('bun', ['run', CLI, note('note.md'), '-p', '0'], {
      env: env({ ...other, AKAPEN_PORT: d.port }),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('on another token');
  });

  it('refuses a second server whose first runs on another token', async () => {
    await serve();
    const r = spawnSync('bun', ['run', CLI, 'serve', '-p', '0'], {
      env: env({ AKAPEN_TOKEN: 'some-other-token' }),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already running');
  });

  it('tells the page about a file deleted and written back later', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    const ctl = new AbortController();
    const frames: string[] = [];
    void authed(`${url}events`, { signal: ctl.signal }).then(async (res) => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of res.body!) frames.push(dec.decode(chunk));
      } catch {
        /* aborted */
      }
    });
    await until(() => frames.length > 0);
    rmSync(file);
    await new Promise((r) => setTimeout(r, 500));
    writeFileSync(file, '# A heading\n\nwritten back\n');
    await until(() => /"changes":[1-9]/.test(frames.join('')));
    ctl.abort();
  });

  it('stops serving a registered document whose file is gone, and lists it as missing', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    rmSync(file);
    expect((await authed(`${url}api/status`)).status).toBe(404);
    const listed = JSON.parse(cli(d, ['list', '--json']).out) as { file: string; missing: boolean }[];
    expect(listed.map((r) => [r.file, r.missing])).toEqual([[file, true]]);
  });

  it('serves a document whose name holds characters a URL has to escape', async () => {
    const d = await serve();
    const file = note('team plan #2.md');
    const url = urlIn(cli(d, ['add', file]).out);
    expect(url).toContain('/d/team%20plan%20%232-');
    expect((await authed(`${url}api/status`)).status).toBe(200);
    const index = await (await authed(`${d.base}/`)).text();
    expect(index).toContain(`href="${new URL(url).pathname.slice(1)}"`);
    // Through the CLI as well, which reaches the document by its id.
    writeFileSync(file, '# A heading\n\nA paragraph.\n\nMore.\n');
    const cut = cli(d, ['rounds', 'cut', file]);
    expect(cut.code, cut.err).toBe(0);
    expect(cut.out).toContain('round 2 is now current');
    const removed = cli(d, ['remove', file]);
    expect(removed.code, removed.err).toBe(0);
  });

  it('removes by an exact id even when it is the prefix of another', async () => {
    const d = await serve();
    const first = urlIn(cli(d, ['add', note('plan.md')]).out);
    const id = /\/d\/([^/]+)\//.exec(first)![1]!;
    const second = urlIn(cli(d, ['add', note(`${id}-x.md`)]).out);
    const r = cli(d, ['remove', id]);
    expect(r.code, r.err).toBe(0);
    expect((await authed(`${first}api/status`)).status).toBe(404);
    expect((await authed(`${second}api/status`)).status).toBe(200);
  });

  it('keeps taking comments on an open document while its file is briefly gone', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    expect((await authed(`${url}api/status`)).status).toBe(200);
    rmSync(file);
    expect((await comment(url, 'while it was gone')).status).toBe(200);
    const stored = (await (await authed(`${url}api/comments`)).json()) as { body: string }[];
    expect(stored.map((c) => c.body)).toEqual(['while it was gone']);
  });

  it('refuses a second server on the same home while the first answers', async () => {
    await serve();
    const r = spawnSync('bun', ['run', CLI, 'serve', '-p', '0'], {
      env: env(),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already running');
  });

  it('gives an untitled document its file name as the link', async () => {
    const d = await serve();
    const url = urlIn(cli(d, ['add', note('plain.md', 'no heading here\n')]).out);
    await authed(`${url}api/status`);
    const index = await (await authed(`${d.base}/`)).text();
    expect(index).toMatch(/<a href="d\/plain-[0-9a-f]{12}\/">plain\.md<\/a>/);
  });

  it('answers 404 for a path nothing is registered under', async () => {
    const d = await serve();
    expect((await authed(`${d.base}/d/nothing-000000000000/api/status`)).status).toBe(404);
  });

  it('stops serving a removed document, keeps its comments, and gives the URL back on add', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    await authed(`${url}api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 1, endLine: 1, body: 'kept' }),
    });

    const removed = cli(d, ['remove', file]);
    expect(removed.code, removed.err).toBe(0);
    expect((await authed(`${url}api/status`)).status).toBe(404);

    expect(urlIn(cli(d, ['add', file]).out)).toBe(url);
    const status = (await (await authed(`${url}api/status`)).json()) as { unresolved: number };
    expect(status.unresolved).toBe(1);
  });

  it('removes by a unique prefix of the id', async () => {
    const d = await serve();
    const url = urlIn(cli(d, ['add', note('note.md')]).out);
    const id = /\/d\/([^/]+)\//.exec(url)![1]!;
    expect(cli(d, ['remove', id.slice(0, 8)]).code).toBe(0);
    expect((await authed(`${url}api/status`)).status).toBe(404);
  });

  it('keeps what is registered across a restart', async () => {
    const first = await serve();
    const file = note('note.md');
    const path = new URL(urlIn(cli(first, ['add', file]).out)).pathname;
    await first.stop();
    running = running.filter((d) => d !== first);

    const second = await serve();
    expect((await authed(`${second.base}${path}api/status`)).status).toBe(200);
  });

  it("unregisters every document of one session, and only that session's", async () => {
    const d = await serve();
    const mine = urlIn(cli(d, ['add', note('a.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const theirs = urlIn(cli(d, ['add', note('b.md')], { CLAUDE_CODE_SESSION_ID: 'session-b' }).out);

    const res = await authed(`${d.base}/api/documents?session=session-a`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { removed: string[] }).removed).toEqual([/\/d\/([^/]+)\//.exec(mine)![1]]);
    expect((await authed(`${mine}api/status`)).status).toBe(404);
    expect((await authed(`${theirs}api/status`)).status).toBe(200);
  });

  it('keeps the session of a document registered again from a shell', async () => {
    const d = await serve();
    const file = note('note.md');
    cli(d, ['add', file], { CLAUDE_CODE_SESSION_ID: 'session-a' });
    cli(d, ['add', file]);
    const listed = JSON.parse(cli(d, ['list', '--json']).out) as { origin: { id: string } | null }[];
    expect(listed.map((r) => r.origin?.id)).toEqual(['session-a']);
  });

  it('presents --token to the server, for one started on a pinned token', async () => {
    const d = await serve();
    const file = note('note.md');
    cli(d, ['add', file]);
    const r = cli(d, ['remove', file, '--token', TOKEN], { AKAPEN_TOKEN: '' });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('removed');
  });

  it('reaches a server on another port with -p', async () => {
    const d = await serve();
    const r = spawnSync('bun', ['run', CLI, 'add', note('note.md'), '-p', d.port], {
      env: env({ AKAPEN_PORT: '1' }),
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`127.0.0.1:${d.port}/d/note-`);
  });

  it('records the registering session, which akapen list --session filters on', async () => {
    const d = await serve();
    const file = note('note.md');
    cli(d, ['add', file], { CLAUDE_CODE_SESSION_ID: 'session-a' });
    cli(d, ['add', note('other.md')], { CLAUDE_CODE_SESSION_ID: 'session-b' });

    const listed = JSON.parse(cli(d, ['list', '--json', '--session', 'session-a']).out) as {
      file: string;
      origin: { id: string } | null;
    }[];
    expect(listed.map((r) => [r.file, r.origin?.id])).toEqual([[file, 'session-a']]);
  });

  it('replies to a comment on a registered document through the daemon', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    const posted = (await (
      await authed(`${url}api/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startLine: 1, endLine: 1, body: 'q' }),
      })
    ).json()) as { comment: { id: string } };

    const r = cli(d, ['reply', file, posted.comment.id, 'answered', '--resolve'], {
      CLAUDE_CODE_SESSION_ID: 'session-a',
    });
    expect(r.code, r.err).toBe(0);
    const [thread] = JSON.parse(cli(d, ['comments', file, '--all']).out) as {
      resolved: boolean;
      replies: { body: string; session_id: string }[];
    }[];
    expect(thread!.resolved).toBe(true);
    expect(thread!.replies.map((x) => [x.body, x.session_id])).toEqual([['answered', 'session-a']]);
  });

  it('refuses add when no daemon answers, and writes nothing', () => {
    const r = cli(null, ['add', note('note.md')]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('akapen serve is not answering');
    expect(existsSync(join(home, 'documents.json'))).toBe(false);
  });

  it('refuses a root that does not hold the document', async () => {
    const d = await serve();
    cli(d, ['add', note('kept.md')]);
    mkdirSync(join(sandbox, 'elsewhere'));
    const r = cli(d, ['add', note('docs/note.md'), '--root', join(sandbox, 'elsewhere')]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('root does not contain the document');
    const registered = JSON.parse(readFileSync(join(home, 'documents.json'), 'utf8')) as {
      documents: { file: string }[];
    };
    expect(registered.documents.map((e) => e.file)).toEqual([join(sandbox, 'kept.md')]);
  });

  it('keeps telling the page about edits saved by rename, one after another', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    const ctl = new AbortController();
    const frames: string[] = [];
    void authed(`${url}events`, { signal: ctl.signal }).then(async (res) => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of res.body!) frames.push(dec.decode(chunk));
      } catch {
        /* aborted */
      }
    });
    const changes = () =>
      frames
        .join('')
        .match(/"changes":(\d+)/g)
        ?.at(-1);
    await until(() => frames.length > 0);
    for (const n of [1, 2, 3]) {
      const tmp = join(sandbox, `save-${n}.tmp`);
      writeFileSync(tmp, `# A heading\n\nsaved ${n}\n`);
      renameSync(tmp, file);
      await until(() => changes() === `"changes":${n}`);
    }
    ctl.abort();
  });

  it('refuses to start on a registry written by a newer layout, and leaves it as it was', () => {
    mkdirSync(home, { recursive: true });
    const newer = JSON.stringify({ version: 2, documents: [] });
    writeFileSync(join(home, 'documents.json'), newer);
    const r = spawnSync('bun', ['run', CLI, 'serve', '-p', '0'], {
      env: env(),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('version 2 is not one this akapen reads');
    expect(readFileSync(join(home, 'documents.json'), 'utf8')).toBe(newer);
  });

  it('refuses the management API to a request a proxy on this machine forwarded', async () => {
    const d = await serve();
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      const res = await authed(`${d.base}/api/documents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [header]: '203.0.113.9' },
        body: JSON.stringify({ file: note('secret.md') }),
      });
      expect(res.status, header).toBe(403);
    }
    expect(existsSync(join(home, 'documents.json'))).toBe(false);
  });

  it('applies a new root by reopening the document, and keeps the root on a re-add without one', async () => {
    const d = await serve();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    mkdirSync(join(sandbox, 'img'), { recursive: true });
    writeFileSync(join(sandbox, 'img', 'a.png'), png);
    const file = note('docs/note.md', '# A\n\n![a](../img/a.png)\n');
    const url = urlIn(cli(d, ['add', file]).out);
    const image = () => authed(`${url}file?path=${encodeURIComponent('../img/a.png')}`);
    expect((await image()).status).toBe(404);

    cli(d, ['add', file, '--root', sandbox]);
    expect((await image()).status).toBe(200);
    cli(d, ['add', file]);
    expect((await image()).status).toBe(200);
  });

  it('refuses to register a file a one-document akapen is serving, and the reverse', async () => {
    const d = await serve();
    const file = note('note.md');
    cli(d, ['add', file]);
    const legacy = spawnSync('bun', ['run', CLI, file, '-p', '0'], {
      env: env({ AKAPEN_PORT: d.port }),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toContain('akapen serve already serves');

    const other = note('other.md');
    const proc = spawn('bun', ['run', CLI, other, '-p', '0'], {
      env: env({ AKAPEN_PORT: d.port }),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const exited = new Promise<void>((done) => proc.on('exit', () => done()));
    try {
      await new Promise<void>((resolve) =>
        proc.stdout.on('data', (c: Buffer) => c.toString().includes('url') && resolve()),
      );
      const r = cli(d, ['add', other]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('a one-document akapen is serving');
    } finally {
      proc.kill();
      await exited;
    }
  });

  it('finds a server started on its own port through what it recorded', async () => {
    const d = await serve();
    const r = spawnSync('bun', ['run', CLI, 'add', note('note.md')], {
      env: { ...env(), AKAPEN_PORT: '' },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`127.0.0.1:${d.port}/d/note-`);
  });

  it('refuses a bind the CLI on this machine could not reach', () => {
    const lan = localAddresses().find((a) => a !== '127.0.0.1' && !a.includes(':'));
    const r = spawnSync('bun', ['run', CLI, 'serve', '-p', '0', '--host', lan ?? '192.0.2.1'], {
      env: env(),
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unable to reach it');
  });

  const lanAddress = localAddresses().find((a) => a !== '127.0.0.1' && !a.includes(':'));
  it.skipIf(lanAddress === undefined)('keeps the management API to this machine', async () => {
    const lan = lanAddress!;
    const d = await serve(['--host', '0.0.0.0']);
    cli(d, ['add', note('note.md')]);

    const fromLan = await authed(`http://${lan}:${d.port}/api/documents`);
    expect(fromLan.status).toBe(403);
    const added = await authed(`http://${lan}:${d.port}/api/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: note('secret.md') }),
    });
    expect(added.status).toBe(403);
    const registered = JSON.parse(readFileSync(join(home, 'documents.json'), 'utf8')) as {
      documents: unknown[];
    };
    expect(registered.documents).toHaveLength(1);
  });
});
