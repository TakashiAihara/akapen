/**
 * `akapen serve`: one process serving every registered document under `/d/<id>/` (#305).
 *
 * Spawned, as server.test.ts does, so the path under test is the one the binary takes.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localAddresses } from '@akapen/core/addresses';
import { collect, holdServeStream, serveStore } from '../../cli/src/channel.ts';
import { chosenServePort, documentId } from '@akapen/core/documents';
import { storeDir } from '@akapen/core/store';

const TOKEN = 'test-token-for-the-daemon-suite';
const CLI = join(import.meta.dirname, '..', '..', 'cli', 'src', 'cli.ts');

const authed = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${TOKEN}` },
  });

/** As the CLI on this machine calls the management API: the token and the management secret. */
const managed = (url: string, init: RequestInit = {}): Promise<Response> =>
  authed(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      'x-akapen-manage': readFileSync(join(home, 'manage-token'), 'utf8').trim(),
    },
  });

type Daemon = { port: string; base: string; stop: () => Promise<void>; output: () => string };

let sandbox: string;
let home: string;
let running: Daemon[] = [];

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  CLAUDE_CODE_SESSION_ID: '',
  AKAPEN_HOME: home,
  AKAPEN_TOKEN: TOKEN,
  // Cleared, so a value exported by whoever runs the suite does not stand in for the file.
  AKAPEN_MANAGE_TOKEN: '',
  ...extra,
});

async function serve(args: string[] = [], extra: NodeJS.ProcessEnv = {}): Promise<Daemon> {
  const proc: ChildProcess = spawn('bun', ['run', CLI, 'serve', '-p', '0', ...args], {
    env: env(extra),
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
  const daemon: Daemon = { port, base: `http://127.0.0.1:${port}`, stop: kill, output: () => out };
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

/**
 * The record a one-document akapen of an earlier version left under `instances/`, named after
 * a process: this one, alive, unless another pid is given. Returns the file name.
 */
function legacyRecord(file: string, pid = process.pid): string {
  mkdirSync(join(home, 'instances'), { recursive: true });
  const name = `${pid}.json`;
  writeFileSync(
    join(home, 'instances', name),
    JSON.stringify({ pid, host: '127.0.0.1', port: 4399, file, startedAt: new Date().toISOString() }),
  );
  return name;
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

const lanAddress = localAddresses().find((a) => a !== '127.0.0.1' && !a.includes(':'));

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

  it('says a server on another token is running, and refuses a command that holds the wrong one', async () => {
    const d = await serve();
    const other = { AKAPEN_TOKEN: 'some-other-token' };
    expect(cli(d, ['list'], other).out).toContain('refused this command');
    const added = cli(d, ['add', note('note.md')], other);
    expect(added.code).toBe(1);
    expect(added.err).toContain('answered 401');
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

  it('does not serve a document whose file went before a round was opened, and lists it as missing', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    rmSync(file);
    expect((await authed(`${url}api/status`)).status).toBe(404);
    // The CLI names the cause, not the server.
    expect(cli(d, ['comments', file]).err).toContain(`no such file: ${file}`);
    // Nor is it handed to the session's channel, which could only be told of a URL that answers 404.
    expect(await (await managed(`${d.base}/api/sessions/session-a/documents`)).json()).toEqual([]);
    const listed = JSON.parse(cli(d, ['list', '--json']).out) as { file: string; missing: boolean }[];
    expect(listed.map((r) => [r.file, r.missing])).toEqual([[file, true]]);
  });

  it('answers an error, not an empty document, for a path that cannot be read and has no round', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    rmSync(file);
    mkdirSync(file);
    expect((await authed(`${url}api/doc`)).status).toBe(500);
  });

  it('keeps taking comments on a document whose file is gone, across a restart', async () => {
    const first = await serve();
    const file = note('note.md');
    const url = urlIn(cli(first, ['add', file], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    expect((await comment(url, 'before')).status).toBe(200);
    await first.stop();
    rmSync(file);

    const d = await serve();
    const again = `${d.base}${new URL(url).pathname}`;
    const answer = await comment(again, 'while it is gone');
    expect(answer.status).toBe(200);
    const written = (await answer.json()) as { comment: { id: string } };
    // The agent told about it can answer from the command line as well.
    const replied = cli(d, ['reply', file, written.comment.id, 'seen']);
    expect(replied.code, replied.err).toBe(0);
    expect(cli(d, ['comments', file]).out).toContain('while it is gone');
    const typo = cli(d, ['reply', `${file}.absent`, written.comment.id, 'seen']);
    expect(typo.code).toBe(1);
    expect(typo.err).toContain(`no such file: ${file}.absent`);
    const listed = JSON.parse(cli(d, ['list', '--json']).out) as Record<string, unknown>[];
    expect(listed.map((r) => [r['missing'], r['title'], r['round'], r['unresolved']])).toEqual([
      [true, 'A heading', 1, 2],
    ]);
    const docs = (await (await managed(`${d.base}/api/sessions/session-a/documents`)).json()) as {
      comments: { body: string }[];
    }[];
    expect(docs.map((x) => x.comments.map((c) => c.body).toSorted())).toEqual([
      ['before', 'while it is gone'],
    ]);

    // Opened with nothing to watch, it still notices the file coming back, and goes on
    // watching it: the look that found it counts one change by itself.
    const changes = async () =>
      ((await (await authed(`${again}api/doc`)).json()) as { changed: { changes: number } }).changed.changes;
    writeFileSync(file, '# A heading\n\nwritten back\n');
    await until(async () => (await changes()) > 0);
    const seen = await changes();
    writeFileSync(file, '# A heading\n\nwritten again\n');
    await until(async () => (await changes()) > seen);
  });

  it('watches again a file that was gone for longer than a save by rename takes', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    expect((await authed(`${url}api/status`)).status).toBe(200);
    rmSync(file);
    // Long enough that looks spaced by doubling alone would next come more than 5 s later.
    await new Promise((r) => setTimeout(r, 7_000));
    const changes = async () =>
      ((await (await authed(`${url}api/doc`)).json()) as { changed: { changes: number } }).changed.changes;
    writeFileSync(file, '# A heading\n\nwritten back\n');
    await until(async () => (await changes()) > 0);
    // The look that found it counts one change by itself; the next one needs the watcher.
    const seen = await changes();
    writeFileSync(file, '# A heading\n\nwritten again\n');
    await until(async () => (await changes()) > seen);
  }, 20_000);

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

    const res = await managed(`${d.base}/api/documents?session=session-a`, { method: 'DELETE' });
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

  it('refuses the management API without the management secret, even from this machine', async () => {
    const d = await serve();
    const body = { method: 'POST', headers: { 'content-type': 'application/json' } };
    const without = await authed(`${d.base}/api/documents`, {
      ...body,
      body: JSON.stringify({ file: note('a.md') }),
    });
    expect(without.status).toBe(403);
    const wrong = await authed(`${d.base}/api/documents`, {
      ...body,
      headers: { ...body.headers, 'x-akapen-manage': 'not-it' },
      body: JSON.stringify({ file: note('b.md') }),
    });
    expect(wrong.status).toBe(403);
    expect((await authed(`${d.base}/api/documents`)).status).toBe(403);
    expect(existsSync(join(home, 'documents.json'))).toBe(false);
    expect(statSync(join(home, 'manage-token')).mode & 0o777).toBe(0o600);
  });

  it('reaches the server directly when the environment names a proxy', async () => {
    const d = await serve();
    const file = note('note.md');
    cli(d, ['add', file]);
    const proxied: string[] = [];
    const proxy = createHttpServer((req, res) => {
      proxied.push(`${req.url} manage=${String(req.headers['x-akapen-manage'])}`);
      res.writeHead(502).end();
    });
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', () => done()));
    const at = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    try {
      // Not spawnSync: the proxy lives in this process, and a blocked loop answers nobody.
      const list = (extra: NodeJS.ProcessEnv) =>
        new Promise<string>((done) => {
          const p = spawn('bun', ['run', CLI, 'list'], {
            env: env({ AKAPEN_PORT: d.port, HTTP_PROXY: at, http_proxy: at, ...extra }),
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          let out = '';
          p.stdout.on('data', (c: Buffer) => (out += c.toString()));
          // Not `exit`, which can come before the last of stdout has been read.
          p.on('close', () => done(out));
        });
      // The lowercase exception list wins over the uppercase one, so each is tried as the one already set.
      for (const extra of [{}, { no_proxy: 'example.com' }, { NO_PROXY: 'example.com' }]) {
        expect(await list({ NO_PROXY: '', no_proxy: '', ...extra })).toContain(file);
        expect(proxied).toEqual([]);
      }
    } finally {
      await new Promise<void>((done) => proxy.close(() => done()));
    }
  });

  it('does not hand the management secret to whatever holds a port this home never chose', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'manage-token'), 'the-secret-that-must-stay\n', { mode: 0o600 });
    const seen: (string | undefined)[] = [];
    const listener = createHttpServer((req, res) => {
      const h = req.headers['x-akapen-manage'];
      seen.push(typeof h === 'string' ? h : undefined);
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    });
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', () => done()));
    const port = (listener.address() as { port: number }).port;
    try {
      // A record left by a server whose process is gone: the port may now belong to anyone.
      // Not spawnSync: the listener lives in this process, and a blocked loop answers nobody.
      const listAsync = (e: NodeJS.ProcessEnv) =>
        new Promise<void>((done) =>
          spawn('bun', ['run', CLI, 'list'], { env: e, stdio: 'ignore' }).on('exit', () => done()),
        );
      writeFileSync(join(home, 'serve.json'), JSON.stringify({ port, pid: 2 ** 22 + 1 }));
      await listAsync({ ...env(), AKAPEN_PORT: '' });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((h) => h === undefined)).toBe(true);

      // Named by AKAPEN_PORT, it is the caller's choice and the secret goes.
      seen.length = 0;
      await listAsync(env({ AKAPEN_PORT: String(port) }));
      expect(seen).toContain('the-secret-that-must-stay');

      // serve's own check for a running server, on the same stale record, sends nothing either.
      seen.length = 0;
      const second = spawn('bun', ['run', CLI, 'serve', '-p', '0'], {
        env: { ...env(), AKAPEN_PORT: '' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const exited = new Promise<void>((done) => second.on('exit', () => done()));
      // The recorded process is gone, so this serve has to start; exiting is a failure.
      let printed = '';
      try {
        await Promise.race([
          exited.then(() => {
            throw new Error(`serve exited instead of starting:\n${printed}`);
          }),
          new Promise<void>((done) =>
            second.stdout.on('data', (c: Buffer) => {
              printed += c.toString();
              if (/url\s+http/.test(printed)) done();
            }),
          ),
          new Promise<void>((_, fail) => setTimeout(() => fail(new Error('serve did not start')), 15_000)),
        ]);
      } finally {
        second.kill();
        await exited;
      }
      expect(seen).toEqual([]);
    } finally {
      await new Promise<void>((done) => listener.close(() => done()));
    }
  });

  it('says the server refused when the management secret is missing, and a second server still refuses', async () => {
    const d = await serve();
    cli(d, ['add', note('note.md')]);
    rmSync(join(home, 'manage-token'));
    const r = cli(d, ['list']);
    expect(r.out).toContain('refused this command');
    expect(r.out).not.toContain('was not sent');
    const comments = cli(d, ['comments', note('note.md')]);
    expect(comments.code).toBe(1);
    expect(comments.err).toContain('refused this command');
    const removed = cli(d, ['remove', 'anything']);
    expect(removed.code).toBe(1);
    expect(removed.err).toContain('refused this command');
    const second = spawnSync('bun', ['run', CLI, 'serve', '-p', '0'], {
      env: { ...env(), AKAPEN_PORT: '', AKAPEN_MANAGE_TOKEN: 'not-the-running-one' },
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already running');
  });

  it('refuses the management API to a request a proxy on this machine forwarded', async () => {
    const d = await serve();
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      const res = await managed(`${d.base}/api/documents`, {
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

  it('moves the comments of an earlier home from reviews/ to comments/ when it starts', async () => {
    const file = note('note.md');
    const first = await serve();
    const url = urlIn(cli(first, ['add', file]).out);
    await comment(url, 'kept');
    await first.stop();
    renameSync(join(home, 'comments'), join(home, 'reviews'));

    const d = await serve();
    expect(existsSync(join(home, 'comments'))).toBe(true);
    expect(existsSync(join(home, 'reviews'))).toBe(false);
    const listed = JSON.parse(cli(d, ['comments', file]).out) as { body: string }[];
    expect(listed.map((c) => c.body)).toEqual(['kept']);
  });

  it('says so when reviews/ turns up again beside comments/', async () => {
    mkdirSync(join(home, 'comments'), { recursive: true });
    mkdirSync(join(home, 'reviews', 'late-0123456789ab'), { recursive: true });
    const d = await serve();
    expect(d.output()).toContain('is still there beside');
    expect(existsSync(join(home, 'reviews', 'late-0123456789ab'))).toBe(true);
  });

  it('keeps reading reviews/ while a one-document akapen from before still writes there', async () => {
    const file = note('note.md');
    const first = await serve();
    const url = urlIn(cli(first, ['add', file]).out);
    await comment(url, 'kept');
    cli(first, ['remove', file]);
    await first.stop();
    renameSync(join(home, 'comments'), join(home, 'reviews'));
    // What the one-document akapen of an earlier version left: a record naming a live process.
    // Nothing writes these any more, so the record is written here as that version wrote it.
    legacyRecord(note('other.md'));
    const d = await serve();
    expect(d.output()).toContain('still in use by a one-document akapen');
    expect(existsSync(join(home, 'comments'))).toBe(false);
    cli(d, ['add', file]);
    const listed = JSON.parse(cli(d, ['comments', file]).out) as { body: string }[];
    expect(listed.map((c) => c.body)).toEqual(['kept']);
  });

  it('does not open a registered document while a one-document akapen from before serves it', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    const record = legacyRecord(file);
    const res = await authed(`${url}api/status`);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(`(pid ${process.pid})`);
    // Not opened at all: opening would have written the first round into the store. Looked up
    // under the server's home, which this process does not have in its environment.
    const rounds = join(home, 'comments', basename(storeDir(file)), 'rounds');
    expect(existsSync(rounds)).toBe(false);
    // And the same lookup does find it once that process is gone and the document opens.
    rmSync(join(home, 'instances', record));
    expect((await authed(`${url}api/status`)).status).toBe(200);
    expect(existsSync(rounds)).toBe(true);
  });

  it('lists nothing for a --session that matches no session', async () => {
    const d = await serve();
    cli(d, ['add', note('note.md')]);
    expect(JSON.parse(cli(d, ['list', '--json', '--session', 'nobody']).out)).toEqual([]);
  });

  it('refuses to register a file a one-document akapen from before is serving', async () => {
    const d = await serve();
    const file = note('note.md');
    legacyRecord(file);
    const r = cli(d, ['add', file]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`a one-document akapen from an earlier version (pid ${process.pid})`);
    expect(JSON.parse(cli(d, ['list', '--json']).out)).toEqual([]);
    // Only the file it serves: another one registers as usual.
    expect(cli(d, ['add', note('other.md')]).code).toBe(0);
  });

  it('leaves the records of one-document akapen where they are, whether their process is there or not', async () => {
    const d = await serve();
    const gone = legacyRecord(note('gone.md'), 2_147_483_646);
    const alive = legacyRecord(note('alive.md'));
    cli(d, ['add', note('other.md')]);
    cli(d, ['list']);
    expect(readdirSync(join(home, 'instances')).toSorted()).toEqual([gone, alive].toSorted());
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

  it.skipIf(lanAddress === undefined)('keeps the management API to this machine', async () => {
    const lan = lanAddress!;
    const d = await serve(['--host', '0.0.0.0']);
    cli(d, ['add', note('note.md')]);

    const fromLan = await managed(`http://${lan}:${d.port}/api/documents`);
    expect(fromLan.status).toBe(403);
    const added = await managed(`http://${lan}:${d.port}/api/documents`, {
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

/** A session's stream, collecting what it carries. */
function hold(d: Daemon, session: string) {
  const ctl = new AbortController();
  const frames: string[] = [];
  const opened = managed(`${d.base}/api/sessions/${session}/events`, { signal: ctl.signal }).then(
    async (res) => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of res.body!) frames.push(dec.decode(chunk));
      } catch {
        /* aborted */
      }
    },
  );
  return { frames, close: () => ctl.abort(), opened };
}

describe('sessions on akapen serve', () => {
  it('gives a resumed session its documents back at the same URLs', async () => {
    const d = await serve();
    const url = urlIn(cli(d, ['add', note('note.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    cli(d, ['add', note('other.md')], { CLAUDE_CODE_SESSION_ID: 'session-b' });

    const removed = cli(d, ['remove', '--session', 'session-a']);
    expect(removed.code, removed.err).toBe(0);
    expect((await authed(`${url}api/status`)).status).toBe(404);

    const restored = cli(d, ['restore', 'session-a']);
    expect(restored.code, restored.err).toBe(0);
    expect(restored.out.trim().split('\n')).toHaveLength(1);
    expect(restored.out).toContain(url);
    expect((await authed(`${url}api/status`)).status).toBe(200);
  });

  it('does not bring back on resume a document removed by hand, and keeps when the others were added', async () => {
    const d = await serve();
    const kept = note('kept.md');
    const url = urlIn(cli(d, ['add', kept], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const dropped = note('dropped.md');
    cli(d, ['add', dropped], { CLAUDE_CODE_SESSION_ID: 'session-a' });
    const addedAt = async () =>
      (
        (await (await managed(`${d.base}/api/documents`)).json()) as { file: string; added_at: string }[]
      ).find((e) => e.file === kept)?.added_at;
    const before = await addedAt();

    expect(cli(d, ['remove', dropped]).code).toBe(0);
    const droppedUrl = `${url.split('/d/')[0]}/d/${encodeURIComponent(documentId(dropped))}/`;
    cli(d, ['remove', '--session', 'session-a']);
    expect((await authed(`${url}api/status`)).status).toBe(404);
    await new Promise((r) => setTimeout(r, 20));
    const restored = cli(d, ['restore', 'session-a']);
    expect(restored.code, restored.err).toBe(0);
    expect(restored.out).toContain(url);
    expect(restored.out).not.toContain(dropped);
    expect((await authed(`${droppedUrl}api/status`)).status).toBe(404);
    expect(await addedAt()).toBe(before);
  });

  it('says which documents it could not restore, and restores the rest', async () => {
    const d = await serve();
    const url = urlIn(cli(d, ['add', note('kept.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const gone = note('gone.md');
    cli(d, ['add', gone], { CLAUDE_CODE_SESSION_ID: 'session-a' });
    cli(d, ['remove', '--session', 'session-a']);
    rmSync(gone);

    const restored = cli(d, ['restore', 'session-a']);
    // A deleted file is reported, not a failure: the resume hook runs this every time.
    expect(restored.code, restored.err).toBe(0);
    expect(restored.err).toContain(`not restored: ${gone}: no such file`);
    expect(restored.out).toContain(url);
    expect(restored.out).not.toContain('nothing to restore');
  });

  it('restores a document whose file is gone when its store holds a round', async () => {
    const d = await serve();
    const file = note('tmp/note.md');
    // With a root that went with it, as when a temporary directory is cleaned away.
    const url = urlIn(
      cli(d, ['add', file, '--root', join(sandbox, 'tmp')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out,
    );
    expect((await comment(url, 'before')).status).toBe(200);
    cli(d, ['remove', '--session', 'session-a']);
    rmSync(join(sandbox, 'tmp'), { recursive: true });

    const restored = cli(d, ['restore', 'session-a']);
    expect(restored.code, restored.err).toBe(0);
    expect(restored.err).not.toContain('not restored');
    expect(restored.out).toContain(url);
    expect((await comment(url, 'after the resume')).status).toBe(200);
  });

  it('wakes the stream of the session a comment belongs to, and no other', async () => {
    const d = await serve();
    const mine = urlIn(cli(d, ['add', note('a.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const theirs = urlIn(cli(d, ['add', note('b.md')], { CLAUDE_CODE_SESSION_ID: 'session-b' }).out);
    const a = hold(d, 'session-a');
    const b = hold(d, 'session-b');
    await until(() => a.frames.length > 0 && b.frames.length > 0);

    await comment(mine, 'for a');
    await until(() => a.frames.some((f) => f.includes('data: changed')));
    await new Promise((r) => setTimeout(r, 200));
    expect(b.frames.some((f) => f.includes('data: changed'))).toBe(false);

    await comment(theirs, 'for b');
    await until(() => b.frames.some((f) => f.includes('data: changed')));

    const before = a.frames.filter((f) => f.includes('data: changed')).length;
    const [posted] = (await (await authed(`${mine}api/comments`)).json()) as { id: string }[];
    await authed(`${mine}api/comments/${posted!.id}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'a reply wakes it too' }),
    });
    await until(() => a.frames.filter((f) => f.includes('data: changed')).length > before);
    a.close();
    b.close();
  });

  it("hands a session's channel its documents with their comments", async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    cli(d, ['add', note('other.md')], { CLAUDE_CODE_SESSION_ID: 'session-b' });
    await comment(url, 'pending');

    const docs = (await (await managed(`${d.base}/api/sessions/session-a/documents`)).json()) as {
      file: string;
      comments: { body: string }[];
    }[];
    expect(docs.map((x) => [x.file, x.comments.map((c) => c.body)])).toEqual([[file, ['pending']]]);
  });

  it('removes the registrations of a session whose channel has gone, and keeps those of one that never came', async () => {
    const d = await serve([], { AKAPEN_DISCONNECT_MS: '300' });
    const gone = urlIn(cli(d, ['add', note('a.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const never = urlIn(cli(d, ['add', note('b.md')], { CLAUDE_CODE_SESSION_ID: 'session-b' }).out);
    const a = hold(d, 'session-a');
    await until(() => a.frames.length > 0);

    a.close();
    await until(async () => (await authed(`${gone}api/status`)).status === 404);
    expect((await authed(`${never}api/status`)).status).toBe(200);
  });

  it('keeps the registrations of a session whose channel came back in time', async () => {
    const d = await serve([], { AKAPEN_DISCONNECT_MS: '600' });
    const url = urlIn(cli(d, ['add', note('a.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const first = hold(d, 'session-a');
    await until(() => first.frames.length > 0);
    first.close();
    const second = hold(d, 'session-a');
    await until(() => second.frames.length > 0);

    await new Promise((r) => setTimeout(r, 1_000));
    expect((await authed(`${url}api/status`)).status).toBe(200);
    second.close();
  });

  it("keeps a resumed session's documents past the removal its old channel's disconnect started", async () => {
    const d = await serve([], { AKAPEN_DISCONNECT_MS: '600' });
    const url = urlIn(cli(d, ['add', note('a.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const old = hold(d, 'session-a');
    await until(() => old.frames.length > 0);
    old.close();
    await new Promise((r) => setTimeout(r, 100));
    // The session ended and was resumed inside the window; its new channel has not connected yet.
    cli(d, ['remove', '--session', 'session-a']);
    expect(cli(d, ['restore', 'session-a']).code).toBe(0);

    await new Promise((r) => setTimeout(r, 1_000));
    expect((await authed(`${url}api/status`)).status).toBe(200);
  });

  it("keeps a resumed session's documents when its old channel's stream closes after the restore", async () => {
    const d = await serve([], { AKAPEN_DISCONNECT_MS: '300' });
    const url = urlIn(cli(d, ['add', note('a.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const old = hold(d, 'session-a');
    await until(() => old.frames.length > 0);
    expect(cli(d, ['restore', 'session-a']).code).toBe(0);
    old.close();

    await new Promise((r) => setTimeout(r, 800));
    expect((await authed(`${url}api/status`)).status).toBe(200);
  });

  it('closes a stream that is still open when its session is restored, so its channel reconnects', async () => {
    const d = await serve();
    cli(d, ['add', note('a.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' });
    const ctl = new AbortController();
    const res = await managed(`${d.base}/api/sessions/session-a/events`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    expect(cli(d, ['restore', 'session-a']).code).toBe(0);
    const end = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return 'closed';
      })(),
      new Promise((r) => setTimeout(() => r('open'), 3_000)),
    ]);
    ctl.abort();
    expect(end).toBe('closed');
  });

  it('still unregisters a resumed session when its new channel goes, whatever its old stream does', async () => {
    const d = await serve([], { AKAPEN_DISCONNECT_MS: '300' });
    const url = urlIn(cli(d, ['add', note('a.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const old = hold(d, 'session-a');
    await until(() => old.frames.length > 0);
    expect(cli(d, ['restore', 'session-a']).code).toBe(0);
    const fresh = hold(d, 'session-a');
    await until(() => fresh.frames.length > 0);

    fresh.close();
    await new Promise((r) => setTimeout(r, 100));
    old.close();
    await until(async () => (await authed(`${url}api/status`)).status === 404);
  });

  it("feeds a session's channel the comments on its documents, with the URL they are reached at", async () => {
    const d = await serve();
    const url = urlIn(cli(d, ['add', note('note.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' }).out);
    const saved = {
      port: process.env['AKAPEN_PORT'],
      home: process.env['AKAPEN_HOME'],
      token: process.env['AKAPEN_TOKEN'],
      manage: process.env['AKAPEN_MANAGE_TOKEN'],
    };
    // A home of its own, as a channel beside a server in a container has: what it reports
    // has to come from the server, not from a store it happens to share.
    Object.assign(process.env, {
      AKAPEN_PORT: d.port,
      AKAPEN_HOME: join(sandbox, 'elsewhere'),
      AKAPEN_MANAGE_TOKEN: readFileSync(join(home, 'manage-token'), 'utf8').trim(),
      AKAPEN_TOKEN: TOKEN,
    });
    try {
      const seen = new Map<string, Set<string>>();
      expect(collect('session-a', seen, await serveStore('session-a'))).toEqual([]);
      await comment(url, 'pushed');
      const events = collect('session-a', seen, await serveStore('session-a'));
      expect(events.map((e) => [e.meta['url'], e.content.includes('pushed')])).toEqual([
        [url.slice(0, -1), true],
      ]);
      expect(collect('session-b', new Map(), await serveStore('session-b'))).toEqual([]);

      // The stream the channel holds: woken by a comment on its session's documents.
      let woken = 0;
      const ctl = new AbortController();
      void holdServeStream('session-a', () => woken++, ctl.signal);
      try {
        // Commented again on each try: nothing says when the stream has subscribed.
        await until(async () => {
          await comment(url, 'woke');
          await new Promise((r) => setTimeout(r, 200));
          return woken > 0;
        });
      } finally {
        ctl.abort();
      }

      // Without AKAPEN_PORT, only a port this home's live server recorded: never a bare default.
      process.env['AKAPEN_PORT'] = '1e3';
      mkdirSync(join(sandbox, 'elsewhere'), { recursive: true });
      // Not decimal digits: not a port, and nothing is recorded to fall back on.
      expect(chosenServePort()).toBeNull();
      delete process.env['AKAPEN_PORT'];
      expect(chosenServePort()).toBeNull();
      writeFileSync(
        join(sandbox, 'elsewhere', 'serve.json'),
        JSON.stringify({ port: Number(d.port), pid: 2 ** 22 + 1 }),
      );
      expect(chosenServePort()).toBeNull();
      writeFileSync(
        join(sandbox, 'elsewhere', 'serve.json'),
        JSON.stringify({ port: Number(d.port), pid: process.pid }),
      );
      expect(chosenServePort()).toBe(Number(d.port));
    } finally {
      for (const [k, v] of [
        ['AKAPEN_PORT', saved.port],
        ['AKAPEN_HOME', saved.home],
        ['AKAPEN_TOKEN', saved.token],
        ['AKAPEN_MANAGE_TOKEN', saved.manage],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('refuses the session routes without the management secret', async () => {
    const d = await serve();
    cli(d, ['add', note('note.md')], { CLAUDE_CODE_SESSION_ID: 'session-a' });
    expect((await authed(`${d.base}/api/sessions/session-a/documents`)).status).toBe(403);
    expect((await authed(`${d.base}/api/sessions/session-a/restore`, { method: 'POST' })).status).toBe(403);
    expect((await authed(`${d.base}/api/sessions/session-a/events`)).status).toBe(403);
  });

  it('answers a session id that is not one with 400, not a server error', async () => {
    const d = await serve();
    expect((await managed(`${d.base}/api/sessions/%E0%A4%A/documents`)).status).toBe(400);
    expect((await managed(`${d.base}/api/sessions/not%20one/documents`)).status).toBe(400);
  });

  it.skipIf(lanAddress === undefined)('keeps the session streams to this machine', async () => {
    const lan = lanAddress!;
    const d = await serve(['--host', '0.0.0.0']);
    expect((await managed(`http://${lan}:${d.port}/api/sessions/session-a/documents`)).status).toBe(403);
    const events = await managed(`http://${lan}:${d.port}/api/sessions/session-a/events`);
    expect(events.status).toBe(403);
    expect(await events.text()).toBe('sessions are this machine only');
  });

  it('reads comments through the server for akapen comments, whatever the file is called', async () => {
    const d = await serve();
    const file = note('a#b c.md');
    const url = urlIn(cli(d, ['add', file]).out);
    await comment(url, 'listed');
    // From a home that is not the server's, so only the server can have answered.
    const listed = JSON.parse(
      cli(d, ['comments', file], {
        AKAPEN_HOME: join(sandbox, 'elsewhere'),
        AKAPEN_MANAGE_TOKEN: readFileSync(join(home, 'manage-token'), 'utf8').trim(),
      }).out,
    ) as {
      body: string;
      id: string;
    }[];
    expect(listed.map((c) => c.body)).toEqual(['listed']);
  });
});

describe('the commands that name a document', () => {
  it('say so, and send nothing, when the document is not registered', async () => {
    const d = await serve();
    const file = note('note.md');
    for (const args of [
      ['comments', file],
      ['reply', file, 'c_1', 'a reply'],
      ['resolve', file, 'c_1'],
      ['rounds', 'cut', file],
    ]) {
      const r = cli(d, args);
      expect(r.code, args[0]).toBe(1);
      expect(r.err, args[0]).toContain(`${file} is not registered with akapen serve`);
      expect(r.err, args[0]).toContain(`akapen add ${file}`);
    }
    expect(JSON.parse(cli(d, ['list', '--json']).out)).toEqual([]);
  });

  it('say that akapen serve is not answering when nothing is', () => {
    const file = note('note.md');
    for (const args of [
      ['comments', file],
      ['reply', file, 'c_1', 'a reply'],
      ['resolve', file, 'c_1'],
      ['rounds', 'cut', file],
    ]) {
      const r = cli(null, args);
      expect(r.code, args[0]).toBe(1);
      expect(r.err, args[0]).toContain('akapen serve is not answering on 127.0.0.1:1');
    }
  });
});

describe('akapen list', () => {
  it('lists the round and the open comments a document has reached, as JSON and as a table', async () => {
    const d = await serve();
    const file = note('note.md');
    const url = urlIn(cli(d, ['add', file]).out);
    await comment(url, 'one');
    await comment(url, 'two');
    writeFileSync(file, '# A heading\n\nChanged.\n');
    expect(cli(d, ['rounds', 'cut', file]).code).toBe(0);
    await comment(url, 'three');

    const [row] = JSON.parse(cli(d, ['list', '--json']).out) as { round: number; unresolved: number }[];
    expect(row).toMatchObject({ round: 2, unresolved: 3 });
    const table = cli(d, ['list']).out;
    expect(table).toMatch(/R002\s+3\s/);

    // Only the comments of the current round are marked as such.
    const listed = JSON.parse(cli(d, ['comments', file]).out) as { body: string; current_round: boolean }[];
    expect(listed.map((c) => [c.body, c.current_round]).toSorted()).toEqual([
      ['one', false],
      ['three', true],
      ['two', false],
    ]);
  });

  it('refuses the options of akapen serve on add, rather than dropping them', async () => {
    const d = await serve();
    const r = cli(d, ['add', note('note.md'), '--css', 'x.css', '--author', 'me']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--css, --author belong to akapen serve');
  });

  it('prints what is registered as JSON, with the path in full', async () => {
    const d = await serve();
    const file = note('note.md');
    // Read from the store, so a document is listed with its round once something has opened it.
    expect((await authed(`${urlIn(cli(d, ['add', file]).out)}api/status`)).status).toBe(200);

    expect(JSON.parse(cli(d, ['list', '--json']).out)).toEqual([
      {
        pid: null,
        host: '127.0.0.1',
        port: Number(d.port),
        url: expect.stringMatching(new RegExp(`^http://127\\.0\\.0\\.1:${d.port}/d/note-[0-9a-f]{12}/$`)),
        // Registered from no session, so there is nothing to attribute it to. Null rather
        // than absent: a consumer filtering on it should not have to tell the two apart.
        origin: null,
        file,
        id: expect.stringMatching(/^note-[0-9a-f]{12}$/),
        title: 'A heading',
        round: 1,
        unresolved: 0,
        missing: false,
        started_at: expect.any(String),
      },
    ]);
  });

  it('prints a table with the round, the url to open and the file in full', async () => {
    const d = await serve();
    const file = note('note.md');
    expect((await authed(`${urlIn(cli(d, ['add', file]).out)}api/status`)).status).toBe(200);

    const out = cli(d, ['list']).out;
    expect(out).toContain('R001');
    expect(out).toContain(file);
    expect(out).toContain('URL');
    expect(out).toContain(`http://127.0.0.1:${d.port}/d/note-`);
  });

  it('says so when no server is running', () => {
    const r = cli(null, ['list']);
    expect(r.out.trim()).toBe('no akapen is running');
    expect(JSON.parse(cli(null, ['list', '--json']).out)).toEqual([]);
  });
});

describe('akapen <file.md>', () => {
  it('is not a way to run akapen: it exits 2 and names akapen serve and akapen add', () => {
    const file = note('note.md');
    for (const args of [[file], [file, '-p', '0'], ['no-such-command']]) {
      const r = cli(null, args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toContain('akapen serve');
      expect(r.err).toContain('akapen add <file.md>');
      expect(r.out).toBe('');
    }
  });

  it('starts nothing: no port is bound and nothing is written to the home', async () => {
    const d = await serve();
    const before = readdirSync(home).toSorted();
    cli(d, [note('note.md')]);
    expect(readdirSync(home).toSorted()).toEqual(before);
    expect(JSON.parse(cli(d, ['list', '--json']).out)).toEqual([]);
  });
});
