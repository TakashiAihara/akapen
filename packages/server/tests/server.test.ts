/**
 * The HTTP surface, at the boundary where unknown JSON becomes a stored comment.
 *
 * Before the contract was a schema, a request body was cast and believed. A fractional
 * line number, a line past the end of the document or a missing field all reached the
 * store, and what came back out was a comment whose anchor matched nothing — feedback
 * that can never be found again. None of that is visible to the type checker, so it is
 * checked here.
 *
 * The server runs as a spawned process rather than being imported. Two reasons: the
 * server embeds its assets through import attributes, which is a Bun feature vitest's
 * transform does not implement; and this is the same path the shipped binary takes.
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommentsPayloadSchema, DocPayloadSchema } from '@akapen/shared';
import * as v from 'valibot';

const SOURCE = ['---', 'title: t', '---', '', '# Heading', '', 'A paragraph.', ''].join('\n');

/** Resolved from this file, not from the working directory, so the runner's cwd is free to move. */
const CLI = join(import.meta.dirname, '..', '..', 'cli', 'src', 'cli.ts');

type Server = { url: string; stop: () => void };

/**
 * Start akapen on a port the OS picks and read the port back off its own output.
 * Choosing a number here would collide with a server someone left running.
 */
async function start(file: string, home: string, extra: string[] = []): Promise<Server> {
  const proc: ChildProcess = spawn('bun', ['run', CLI, file, '-p', '0', ...extra], {
    env: { ...process.env, AKAPEN_HOME: home },
    // stderr is piped, not dropped: when startup fails, the reason is only on stderr,
    // and a discarded one turns every failure into a bare timeout.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stop = () => void proc.kill();
  let out = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      // Shorter than the hook timeout below, so a server that never starts is reported
      // as "did not start" with its output rather than as a hook that ran out of time.
      const timer = setTimeout(() => reject(new Error(`akapen did not start:\n${out}`)), 15_000);
      proc.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const found = /url\s+http:\/\/[^:]+:(\d+)/.exec(out);
        if (!found) return;
        clearTimeout(timer);
        resolve(found[1]!);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`akapen exited with ${code}\n${out}`));
      });
    });

    return { url: `http://127.0.0.1:${port}`, stop };
  } catch (err) {
    // Nothing else can reach this process: the caller never receives a handle, and the
    // hook fails before `server` is assigned, so afterEach has nothing to stop. Without
    // this, a run that times out leaves a bun process holding the note and its store.
    stop();
    throw err;
  }
}

let sandbox: string;
let work: string;
let server: Server | null = null;
let base: string;

// Spawning bun and waiting for it to listen does not fit vitest's 10s default, and a
// hook that times out reports itself instead of the startup output that says why.
beforeEach(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'akapen-server-'));
  work = join(sandbox, 'note.md');
  writeFileSync(work, SOURCE);
  server = await start(work, join(sandbox, 'home'));
  base = server.url;
}, 30_000);

afterEach(() => {
  // Guarded: if beforeEach threw, stopping a server that was never started would fail
  // on top of the real error and hide it.
  server?.stop();
  server = null;
  rmSync(sandbox, { recursive: true, force: true });
});

const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

describe('the document', () => {
  it('answers with a payload that satisfies the contract', async () => {
    const res = await fetch(`${base}/api/doc`);
    expect(res.ok).toBe(true);
    // parse, not a cast: a field the browser relies on going missing has to fail here
    const payload = v.parse(DocPayloadSchema, await res.json());
    expect(payload.round.n).toBe(1);
    expect(payload.doc.blocks.length).toBeGreaterThan(0);
  });

  it('refuses a round that is not a positive integer instead of reading it as NaN', async () => {
    expect((await fetch(`${base}/api/doc?round=abc`)).status).toBe(400);
    expect((await fetch(`${base}/api/doc?round=0`)).status).toBe(400);
    expect((await fetch(`${base}/api/doc?round=1.5`)).status).toBe(400);
  });

  it('answers 404 for a round that is well formed but does not exist', async () => {
    expect((await fetch(`${base}/api/doc?round=99`)).status).toBe(404);
  });
});

describe('creating a comment', () => {
  it('stores one and anchors it to the source text', async () => {
    const res = await post('/api/comments', { startLine: 5, endLine: 5, body: 'about the heading' });
    expect(res.ok).toBe(true);
    const payload = v.parse(CommentsPayloadSchema, await res.json());
    expect(payload.comments).toHaveLength(1);
    expect(payload.comment.anchor).toBe('# Heading');
  });

  it.each([
    ['a missing body', { startLine: 5, endLine: 5 }],
    ['an empty body', { startLine: 5, endLine: 5, body: '' }],
    ['a line number of zero', { startLine: 0, endLine: 0, body: 'x' }],
    ['a fractional line number', { startLine: 1.5, endLine: 1.5, body: 'x' }],
    ['a line number sent as a string', { startLine: '5', endLine: '5', body: 'x' }],
  ])('refuses %s', async (_label, body) => {
    expect((await post('/api/comments', body)).status).toBe(400);
  });

  it('refuses a range the document does not have', async () => {
    // The schema cannot see the snapshot, so the range is checked against it separately.
    // Accepting this would store a comment whose anchor is empty and matches nothing.
    expect((await post('/api/comments', { startLine: 900, endLine: 900, body: 'x' })).status).toBe(400);
    expect((await post('/api/comments', { startLine: 5, endLine: 2, body: 'x' })).status).toBe(400);
  });

  it('refuses a range that points at no text', async () => {
    // SOURCE ends with a newline, so split gives an eighth element that is not a line
    // anyone can see. Line 4 is a real but blank line. Neither is addressable, and both
    // used to be accepted and stored with an empty anchor.
    expect((await post('/api/comments', { startLine: 8, endLine: 8, body: 'x' })).status).toBe(400);
    expect((await post('/api/comments', { startLine: 4, endLine: 4, body: 'x' })).status).toBe(400);
    // A range that spans a blank line but also covers text is fine.
    expect((await post('/api/comments', { startLine: 4, endLine: 5, body: 'x' })).ok).toBe(true);
  });

  it('leaves nothing behind when a request is refused', async () => {
    await post('/api/comments', { startLine: 900, endLine: 900, body: 'x' });
    expect(await (await fetch(`${base}/api/comments`)).json()).toEqual([]);
  });
});

describe('resolving', () => {
  it('toggles a comment, and answers 404 for one that does not exist', async () => {
    const created = v.parse(
      CommentsPayloadSchema,
      await (await post('/api/comments', { startLine: 5, endLine: 5, body: 'x' })).json(),
    );
    const id = created.comment.id;

    const resolved = v.parse(CommentsPayloadSchema, await (await post(`/api/comments/${id}/resolve`)).json());
    expect(resolved.comment.resolved).toBe(true);

    const reopened = v.parse(CommentsPayloadSchema, await (await post(`/api/comments/${id}/resolve`)).json());
    expect(reopened.comment.resolved).toBe(false);

    expect((await post('/api/comments/c_nope/resolve')).status).toBe(404);
  });
});

describe('what is served', () => {
  it('answers 404 for a path that is not a registered asset', async () => {
    // Only what ASSETS names is served, so there is no directory to walk out of.
    // `/../package.json` is not worth asserting: fetch folds it to `/package.json`
    // before the request leaves, so the server never sees the `..`. An encoded slash
    // survives normalisation and does reach the lookup.
    expect((await fetch(`${base}/nope.txt`)).status).toBe(404);
    expect((await fetch(`${base}/..%2fpackage.json`)).status).toBe(404);
  });

  it('answers 404 for a name that only exists on Object.prototype', async () => {
    // The lookup key comes straight from the URL. With an ordinary object literal these
    // find a function, pass the truthy check and reach Bun.file() as a 500.
    expect((await fetch(`${base}/constructor`)).status).toBe(404);
    expect((await fetch(`${base}/toString`)).status).toBe(404);
    expect((await fetch(`${base}/__proto__`)).status).toBe(404);
  });

  it('falls back to the default keymap when the override is broken JSON', async () => {
    // A typo in a config file must not make the tool unusable, so the server answers
    // with an empty override rather than failing the request.
    const broken = join(sandbox, 'keymap.json');
    writeFileSync(broken, '{ "row.next": [');
    const other = await start(work, join(sandbox, 'home'), ['--keymap', broken]);
    try {
      const res = await fetch(`${other.url}/keymap.json`);
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({});
    } finally {
      other.stop();
    }
  });
});

describe('replying', () => {
  const createComment = async () =>
    v.parse(
      CommentsPayloadSchema,
      await (await post('/api/comments', { startLine: 5, endLine: 5, body: 'about the heading' })).json(),
    ).comment;

  it('adds a reply and stamps the author kind server-side', async () => {
    const parent = await createComment();
    const res = await post(`/api/comments/${parent.id}/replies`, { body: 'reworded' });
    expect(res.ok).toBe(true);
    const payload = v.parse(CommentsPayloadSchema, await res.json());
    expect(payload.comment.replies).toHaveLength(1);
    expect(payload.comment.replies[0]?.body).toBe('reworded');
    expect(payload.comment.replies[0]?.authorKind).toBe('human');
  });

  it('ignores an author kind the client claims, since nothing authenticates it', async () => {
    const parent = await createComment();
    const res = await post(`/api/comments/${parent.id}/replies`, { body: 'x', authorKind: 'agent' });
    const payload = v.parse(CommentsPayloadSchema, await res.json());
    expect(payload.comment.replies[0]?.authorKind).toBe('human');
  });

  it.each([
    ['a missing body', {}],
    ['an empty body', { body: '' }],
  ])('refuses %s', async (_label, body) => {
    const parent = await createComment();
    expect((await post(`/api/comments/${parent.id}/replies`, body)).status).toBe(400);
  });

  it('answers 404 for a comment that does not exist', async () => {
    expect((await post('/api/comments/c_nope/replies', { body: 'x' })).status).toBe(404);
  });

  it('shows the thread in the document payload', async () => {
    const parent = await createComment();
    await post(`/api/comments/${parent.id}/replies`, { body: 'reworded' });
    const payload = v.parse(DocPayloadSchema, await (await fetch(`${base}/api/doc`)).json());
    expect(payload.comments[0]?.replies?.[0]?.body).toBe('reworded');
  });

  it('reads a stored comment with no replies key as having none', async () => {
    // Every file written before this feature has no such key. Defaulting it is what
    // keeps the browser-side checking from rejecting them and leaving a blank screen.
    //
    // The file has to be edited *between* two servers. A running one holds the current
    // round's comments in memory and /api/doc answers from there, so mutating the file
    // under it proves nothing — an earlier version of this test did exactly that and
    // passed while never reading the old shape at all.
    const parent = await createComment();
    const home = join(sandbox, 'home');
    server?.stop();
    server = null;

    const roundFile = execSync(`find ${home} -name comments.json`, { encoding: 'utf8' }).trim();
    const raw = JSON.parse(readFileSync(roundFile, 'utf8')) as Record<string, unknown>[];
    expect(raw[0]?.['replies']).toBeDefined();
    for (const c of raw) delete c['replies'];
    writeFileSync(roundFile, JSON.stringify(raw, null, 2));

    server = await start(work, home);
    const payload = v.parse(DocPayloadSchema, await (await fetch(`${server.url}/api/doc`)).json());
    expect(payload.comments.find((c) => c.id === parent.id)?.replies).toEqual([]);
  }, 30_000);
});
