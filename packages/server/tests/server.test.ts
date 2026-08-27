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
import { execFileSync, execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommentsPayloadSchema,
  DocPayloadSchema,
  InstancesPayloadSchema,
  ServerEventSchema,
  StatusPayloadSchema,
} from '@akapen/shared';
import * as v from 'valibot';

const SOURCE = ['---', 'title: t', '---', '', '# Heading', '', 'A paragraph.', ''].join('\n');

/**
 * The token every server in this file is started with.
 *
 * Fixed rather than read back from the store, so a request can be made deliberately
 * wrong (`WRONG_TOKEN`) without first having to learn what right looks like.
 */
const TOKEN = 'test-token-for-the-server-suite';
const WRONG_TOKEN = 'not-the-token';

/**
 * `fetch`, with the credential attached.
 *
 * Authentication is on at every bind address, so every request in this file needs one,
 * and threading a header through twenty-nine call sites would bury what each test is
 * actually about. Shadowing the global here is the whole change; `globalThis.fetch` is
 * still reachable, and the authentication tests below use it to send nothing at all.
 */
const fetch = (input: string | URL, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${TOKEN}` },
  });

/** Resolved from this file, not from the working directory, so the runner's cwd is free to move. */
const CLI = join(import.meta.dirname, '..', '..', 'cli', 'src', 'cli.ts');

type Server = {
  url: string;
  port: string;
  /** The registry entry is named after this, and stopping it has to take the entry with it. */
  pid: number;
  stop: () => void;
  /** Resolves once the process is gone, so shutdown can be asserted rather than assumed. */
  stopped: Promise<void>;
};

/**
 * Start akapen on a port the OS picks and read the port back off its own output.
 * Choosing a number here would collide with a server someone left running.
 */
async function start(
  file: string,
  home: string,
  extra: string[] = [],
  opts: { token?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<Server> {
  // `null` leaves AKAPEN_TOKEN out, so the server generates and stores one — the path
  // the everyday case takes, and the only way to test what it writes.
  const token = opts.token === undefined ? TOKEN : opts.token;
  const proc: ChildProcess = spawn('bun', ['run', CLI, file, '-p', '0', ...extra], {
    env: {
      ...process.env,
      // Cleared unless a test sets them. akapen reads the origin off the environment,
      // and these tests are themselves run by something that may export a session id —
      // inheriting it would make what is asserted depend on who ran the suite, and pass
      // in CI while failing on the machine that wrote it.
      CLAUDE_CODE_SESSION_ID: '',
      AKAPEN_ORIGIN_LABEL: '',
      AKAPEN_HOME: home,
      ...(token === null ? {} : { AKAPEN_TOKEN: token }),
      ...opts.env,
    },
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

    return {
      url: `http://127.0.0.1:${port}`,
      port,
      pid: proc.pid!,
      stop,
      stopped: new Promise<void>((done) => proc.on('exit', () => done())),
    };
  } catch (err) {
    // Nothing else can reach this process: the caller never receives a handle, and the
    // hook fails before `server` is assigned, so afterEach has nothing to stop. Without
    // this, a run that times out leaves a bun process holding the note and its store.
    stop();
    throw err;
  }
}

/**
 * A pid nothing is using, for imitating an instance that crashed. Walking down from a
 * high number rather than picking one: a fixed number is a live process on somebody's
 * machine, and EPERM means one is there and owned by someone else.
 */
function deadPid(): number {
  for (let pid = 99_999; pid > 1; pid--) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('every pid up to 99999 is in use');
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

/** The instances one server can see, checked against the contract rather than cast. */
const peers = async (from: string) =>
  v.parse(InstancesPayloadSchema, await (await fetch(`${from}/api/instances`)).json()).instances;

const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

/** Poll until a condition holds. Used for anything that arrives on the stream rather than as a reply. */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Read /events as a second screen would.
 *
 * EventSource does not exist here, and the point of these tests is what a screen that
 * did *not* make the request is told, so the frames are parsed rather than mocked.
 */
function listen(url: string) {
  const seen: unknown[] = [];
  const ctrl = new AbortController();
  const done = (async () => {
    try {
      const res = await fetch(`${url}/events`, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buf += dec.decode(chunk.value, { stream: true });
        let cut = buf.indexOf('\n\n');
        while (cut !== -1) {
          const line = buf
            .slice(0, cut)
            .split('\n')
            .find((l) => l.startsWith('data: '));
          buf = buf.slice(cut + 2);
          if (line) seen.push(JSON.parse(line.slice(6)));
          cut = buf.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted, or the server went away with the test */
    }
  })();
  return { seen, stop: async () => (ctrl.abort(), done) };
}

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

/**
 * A document holding one of every block kind, including the ones that used to be
 * refused: a blank line inside a fence and inside an indented code block. Both are
 * drawn, both get a `+`, and both were answered with 400 (#101).
 */
const PROBE = [
  '---',
  'title: probe',
  '---',
  '',
  '# probe',
  '',
  'alpha の段落',
  '',
  '```bash',
  'echo one',
  '',
  'echo two',
  '```',
  '',
  '> 引用の 1 行目',
  '>',
  '> 引用の 2 行目',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '    インデントされたコードブロック',
  '',
  '    その 2 行目',
  '',
  '- リスト項目',
  '',
  '```mermaid',
  'graph LR',
  '  a --> b',
  '```',
  '',
  '---',
  '',
].join('\n');

describe('what a comment may point at', () => {
  let probe: Server;
  let probeUrl: string;

  beforeEach(async () => {
    const file = join(sandbox, 'probe.md');
    writeFileSync(file, PROBE);
    probe = await start(file, join(sandbox, 'probe-home'));
    probeUrl = probe.url;
  }, 30_000);

  afterEach(() => probe?.stop());

  const doc = async () => v.parse(DocPayloadSchema, await (await fetch(`${probeUrl}/api/doc`)).json()).doc;

  const comment = (startLine: number, endLine: number) =>
    fetch(`${probeUrl}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine, endLine, body: 'x' }),
    });

  /**
   * Not a list of cases. The screen can only offer what /api/doc returned, so asking
   * every block is the whole question — and it keeps catching kinds nobody thought to
   * enumerate, which is how the blank line inside a fence was missed in the first place.
   */
  it('accepts every block the document offers', async () => {
    const { blocks } = await doc();
    const refused: string[] = [];
    for (const b of blocks) {
      const res = await comment(b.startLine, b.endLine);
      if (!res.ok) refused.push(`L${b.startLine}-${b.endLine} ${b.kind} ${JSON.stringify(b.text)}`);
    }
    expect(refused).toEqual([]);
  });

  it('really does contain the blank code lines this is about', async () => {
    // Without this the test above passes on a fixture that drifted away from the case.
    const blank = (await doc()).blocks.filter((b) => b.kind === 'code' && !b.text.trim());
    expect(blank.length).toBeGreaterThanOrEqual(2);
  });

  it('still refuses a line that belongs to no block', async () => {
    // The blank lines *between* blocks are not on the screen and never were. Passing
    // the test above by accepting everything has to fail here.
    const { blocks, lineCount } = await doc();
    const covered = new Set<number>();
    for (const b of blocks) for (let ln = b.startLine; ln <= b.endLine; ln++) covered.add(ln);
    const orphans = [];
    for (let ln = 1; ln <= lineCount; ln++) if (!covered.has(ln)) orphans.push(ln);
    expect(orphans.length).toBeGreaterThan(0);
    for (const ln of orphans) expect((await comment(ln, ln)).status).toBe(400);
  });

  it('still refuses a line past the end of the document', async () => {
    const { lineCount } = await doc();
    expect((await comment(lineCount + 1, lineCount + 1)).status).toBe(400);
    expect((await comment(900, 900)).status).toBe(400);
  });

  it('still refuses a range that starts on text and runs past the end', async () => {
    // Overlapping one block is not enough on its own: the range would be stored with an
    // end nothing in the document reaches, and the anchor would trail empty lines.
    const { blocks, lineCount } = await doc();
    const first = blocks[0]!;
    expect((await comment(first.startLine, lineCount + 1)).status).toBe(400);
    expect((await comment(first.startLine, 900)).status).toBe(400);
  });

  it('still accepts a range running from one block to another across the gap between them', async () => {
    // The blank lines separating two blocks are inside any multi-row selection made in
    // the gutter. Requiring every line in the range to belong to a block would refuse
    // exactly what the screen offers, so overlap is the test, not coverage.
    const { blocks } = await doc();
    const gapped = blocks.find((b, i) => i > 0 && b.startLine > blocks[i - 1]!.endLine + 1);
    expect(gapped).toBeDefined();
    const before = blocks[blocks.indexOf(gapped!) - 1]!;
    expect((await comment(before.startLine, gapped!.endLine)).ok).toBe(true);
  });

  it('still refuses a range whose end is before its start', async () => {
    // Inverted *inside* one block, so the overlap test on its own still matches it.
    // Picking two separate blocks would pass with no ordering check at all.
    const spanning = (await doc()).blocks.find((b) => b.endLine > b.startLine);
    expect(spanning).toBeDefined();
    expect((await comment(spanning!.endLine, spanning!.startLine)).status).toBe(400);
    expect((await comment(7, 5)).status).toBe(400);
  });

  /**
   * A comment on a blank line anchors to an empty string, and the anchor is what
   * carries a comment across rounds — so this one is visible in `carried` but there is
   * no text for an agent to find it by. That is a known gap, left open on purpose:
   * refusing the comment instead is worse, because then it cannot be written at all
   * (#101). This test is here so the gap is recorded rather than assumed away.
   */
  it('carries a blank-line comment over with an anchor that locates nothing', async () => {
    const blank = (await doc()).blocks.find((b) => b.kind === 'code' && !b.text.trim())!;
    const created = v.parse(
      CommentsPayloadSchema,
      await (await comment(blank.startLine, blank.endLine)).json(),
    );
    expect(created.comment.anchor).toBe('');

    await fetch(`${probeUrl}/api/rounds`, { method: 'POST' });
    const carried = v.parse(DocPayloadSchema, await (await fetch(`${probeUrl}/api/doc`)).json()).carried;
    const kept = carried.find((c) => c.id === created.comment.id);
    expect(kept).toBeDefined();
    expect(kept?.anchor).toBe('');
  }, 30_000);
});

describe('a round moving under another screen', () => {
  /**
   * akapen is served on 0.0.0.0 and read from a phone and a laptop at once, so a round
   * cut on one of them while the other is reading is ordinary, not exotic. The other
   * screen keeps the previous round's line numbers, and every comment written on it
   * used to come back as "line range does not point at any text" (#100).
   */
  it('refuses a comment carrying a round that is no longer current', async () => {
    expect((await post('/api/comments', { startLine: 5, endLine: 5, body: 'x', round: 1 })).ok).toBe(true);
    expect((await post('/api/rounds')).ok).toBe(true);

    const res = await post('/api/comments', { startLine: 5, endLine: 5, body: 'x', round: 1 });
    expect(res.status).toBe(409);
    // Not the blank-line message: a person has to be able to tell "reload" from "that
    // line has nothing on it", and 400 vs 409 is how the browser tells them apart too.
    expect(await res.text()).toMatch(/round moved/);
  });

  it('still accepts a comment from a screen that is on the current round', async () => {
    // Refusing every request that names a round would pass the test above.
    expect((await post('/api/rounds')).ok).toBe(true);
    expect((await post('/api/comments', { startLine: 5, endLine: 5, body: 'x', round: 2 })).ok).toBe(true);
  });

  it('still accepts a comment from a client that names no round', async () => {
    // A tab loaded before this field existed, and `akapen` scripted from a shell.
    expect((await post('/api/comments', { startLine: 5, endLine: 5, body: 'x' })).ok).toBe(true);
  });

  it('tells the streams that are open, not just the one that asked', async () => {
    const other = listen(base);
    try {
      await until(() => other.seen.length > 0); // the greeting, so the stream is attached
      expect((await post('/api/rounds')).ok).toBe(true);
      await until(() =>
        other.seen.some(
          (e) => v.safeParse(ServerEventSchema, e).success && (e as { type: string }).type === 'round',
        ),
      );
      const moved = other.seen.filter((e) => (e as { type: string }).type === 'round');
      expect(v.parse(ServerEventSchema, moved.at(-1))).toEqual({ type: 'round', n: 2 });
    } finally {
      await other.stop();
    }
  }, 30_000);
});

/** Every frozen document the rounds under a store hold. A round is only useful if it has one. */
function frozen(home: string): string[] {
  // readdirSync rather than `find`: the path goes into a shell there, so a sandbox with a
  // space in it splits into two arguments and a metacharacter is read as syntax.
  return readdirSync(home, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name === 'content.md')
    .map((e) => readFileSync(join(e.parentPath, e.name), 'utf8'));
}

/**
 * Rewrite a file, through a rename, every 10ms, from a process that does nothing else.
 *
 * As a `setInterval` here it ran on the vitest worker's event loop, which is shared with
 * whatever the runner is doing between tests, and a stall there stops the writes without
 * stopping the server — the two reads match, the round is cut, and the test reports the
 * guard as missing when what went missing was the writer.
 *
 * Through a rename, not a plain write: `writeFileSync` truncates before it writes, so the
 * file really is empty in between, and a read landing in that window is refused for being
 * empty — the other guard, a correct refusal, and one that leaves this test pinning
 * neither path. That is what #119 was about.
 */
function moveFile(path: string): { stop: () => Promise<void> } {
  const proc = spawn(
    'bun',
    [
      '-e',
      `import { writeFileSync, renameSync } from 'node:fs';
       const file = process.env.AKAPEN_TEST_MOVING_FILE;
       let i = 0;
       setInterval(() => {
         writeFileSync(file + '.writing', '# still writing ' + i++ + '\\n');
         renameSync(file + '.writing', file);
       }, 10);`,
    ],
    { env: { ...process.env, AKAPEN_TEST_MOVING_FILE: path }, stdio: 'ignore' },
  );
  return {
    // Awaited, not fired and forgotten: whatever is written next would race a writer
    // that is still alive, and the test would go on to assert against that file.
    stop: async () => {
      proc.kill();
      await new Promise<void>((done) => proc.on('exit', () => done()));
    },
  };
}

describe('cutting a round while the file is being written', () => {
  it('does not freeze a round on a file that is halfway through being replaced', async () => {
    // An editing agent truncates and writes back. This is the gap in between.
    writeFileSync(work, '');
    const res = await post('/api/rounds');
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/empty/);

    // What makes this one unrecoverable is that putting the file back does not undo it:
    // the round already holds the empty copy, and its snapshot is frozen.
    writeFileSync(work, SOURCE);
    const payload = v.parse(DocPayloadSchema, await (await fetch(`${base}/api/doc`)).json());
    expect(payload.round.n).toBe(1);
    expect(payload.doc.blocks.length).toBeGreaterThan(0);
    expect(frozen(join(sandbox, 'home')).filter((c) => c === '')).toEqual([]);

    // And the round can be cut normally once the write is over.
    expect((await post('/api/rounds')).ok).toBe(true);
  }, 30_000);

  it('opens one round when two screens cut at the same moment, not one each', async () => {
    // Both screens show the banner, so both people press the button. Waiting for the file
    // to settle hands control back mid-request, and without a guard each request opened a
    // round: two identical documents, the first closed before anything could be written
    // on it, and the screen that opened it already behind.
    writeFileSync(work, `${SOURCE}\nsomething the agent added\n`);
    const [a, b] = await Promise.all([post('/api/rounds'), post('/api/rounds')]);
    const results = [a.status, b.status].toSorted();
    expect(results).toEqual([200, 409]);
    expect(frozen(join(sandbox, 'home'))).toHaveLength(2); // the first round, and one new one
    expect(v.parse(DocPayloadSchema, await (await fetch(`${base}/api/doc`)).json()).round.n).toBe(2);
  }, 30_000);

  it('still cuts a second round when the two are not at the same moment', async () => {
    // Refusing every second request would pass the test above and make the button work
    // once per process.
    writeFileSync(work, `${SOURCE}\nfirst edit\n`);
    expect((await post('/api/rounds')).status).toBe(200);
    writeFileSync(work, `${SOURCE}\nsecond edit\n`);
    expect((await post('/api/rounds')).status).toBe(200);
    expect(v.parse(DocPayloadSchema, await (await fetch(`${base}/api/doc`)).json()).round.n).toBe(3);
  }, 30_000);

  it('opens a round on a document that was empty to begin with', async () => {
    // The other direction. A guard that refuses whenever the file is empty would pass
    // the test above and leave a blank note — a legitimate thing to review — unusable.
    const file = join(sandbox, 'empty.md');
    writeFileSync(file, '');
    const other = await start(file, join(sandbox, 'empty-home'));
    try {
      const res = await fetch(`${other.url}/api/rounds`, { method: 'POST' });
      expect(res.ok).toBe(true);
      expect(v.parse(DocPayloadSchema, await res.json()).round.n).toBe(2);
    } finally {
      other.stop();
    }
  }, 30_000);

  /**
   * The gap this server leaves between the two reads that decide the file has settled.
   *
   * Twenty times the shipped 50ms, and half of the fix for #135. The assertion below needs
   * a write to land inside every one of those gaps, and nothing couples the writer to the
   * reader, so all the assertion ever had was that one timer outran the other. At 50ms the
   * room was five writes, and a runner that stalled the writer past a single gap took the
   * two reads back to matching and answered 200 — twice on CI, once on `main`.
   *
   * The other half is that the writer no longer shares an event loop with vitest (see
   * `moveFile`), which is what was doing the stalling. Between them, losing this race
   * needs a process that does nothing else to be held off a CPU for a full second.
   */
  const SETTLE_MS = 1_000;

  it('refuses while the file is still moving, rather than freezing what it caught', async () => {
    /**
     * Non-empty the whole time, so the empty guard cannot be what refuses this. Only
     * reading twice and comparing can tell that the file has not settled. `moveFile` above
     * is what keeps that true, and why it writes the way it does.
     *
     * On its own server and its own file: the interval is handed over at startup, and the
     * shared one in `beforeEach` was started without it. A separate file also keeps this
     * churn out of the shared server's watcher.
     */
    const file = join(sandbox, 'moving.md');
    writeFileSync(file, SOURCE);
    const other = await start(file, join(sandbox, 'moving-home'), [], {
      env: { AKAPEN_SETTLE_MS: String(SETTLE_MS) },
    });
    try {
      const writer = moveFile(file);
      try {
        // Nothing asserts a writer that never started: the file would sit still, the round
        // would be cut, and the failure would read as the guard being gone. Wait for the
        // first write to land, so a writer that cannot start times out saying so instead.
        await until(() => readFileSync(file, 'utf8').startsWith('# still writing'));
        const started = Date.now();
        const res = await fetch(`${other.url}/api/rounds`, { method: 'POST' });
        const took = Date.now() - started;
        expect(res.status).toBe(409);
        expect(await res.text()).toMatch(/still being written/);
        // The margin above only exists if the server took the interval it was handed. A
        // variable that never reached the process, or a name it does not read, silently
        // returns it to the shipped 50ms and brings the flake back with nothing saying
        // so. Refusing costs one gap per try: measured, this refusal takes upwards of
        // six seconds, and the same refusal on the shipped 50ms takes 365ms.
        //
        // Five gaps, against a floor of six. One would also be cleared by the 50ms server
        // on a runner that stalled two thirds of a second, and this is measured from here
        // rather than inside the server, so a stall after the reply arrives counts toward
        // it just as much as the reading did. That is the honest limit of this check: it
        // catches an interval that never arrived, which is the way this breaks — a name
        // the server no longer reads, a variable that never reached the process — and it
        // is not proof, because a stall of several seconds landing in the right place
        // would clear it too.
        expect(took).toBeGreaterThan(SETTLE_MS * 5);
      } finally {
        await writer.stop();
      }
      writeFileSync(file, SOURCE);
      expect((await fetch(`${other.url}/api/rounds`, { method: 'POST' })).ok).toBe(true);
    } finally {
      other.stop();
    }
  }, 30_000);
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

/**
 * Finding the other akapen on this host.
 *
 * Every instance drops a file naming itself under AKAPEN_HOME, and a reader proves each
 * one is alive by asking it. Both halves fail quietly when they break: a stale entry is
 * a row that goes nowhere, and an entry that outlives its process makes every reader pay
 * a timeout to discover it. The tests share one home, since that is the boundary of what
 * an instance can see.
 */
describe('the other instances on this host', () => {
  const home = () => join(sandbox, 'home');
  const instancesDir = () => join(home(), 'instances');

  /** A second akapen, with its own file so the two rows can be told apart. */
  const startPeer = (name: string, extra: string[] = []) => {
    const file = join(sandbox, name);
    writeFileSync(file, SOURCE);
    return start(file, home(), extra);
  };

  it('reports what it is showing, by basename', async () => {
    const before = v.parse(StatusPayloadSchema, await (await fetch(`${base}/api/status`)).json());
    expect(before).toEqual({ file: 'note.md', round: 1, unresolved: 0 });

    await post('/api/comments', { startLine: 5, endLine: 5, body: 'x' });

    const after = v.parse(StatusPayloadSchema, await (await fetch(`${base}/api/status`)).json());
    expect(after.unresolved).toBe(1);
    // The path is not in the payload at all. The switcher is read over the LAN with
    // nothing authenticating a reader, and directory layout is not something to hand out.
    expect(JSON.stringify(after)).not.toContain(sandbox);
  });

  it('lists the other instance, and never itself', async () => {
    const peer = await startPeer('design.md');
    try {
      const ours = await peers(base);
      expect(ours).toHaveLength(1);
      expect(ours[0]).toMatchObject({ pid: peer.pid, file: 'design.md', round: 1, unresolved: 0 });
      expect(ours[0]!.port).toBe(Number(peer.port));

      // Both directions: the registry is shared, so seeing each other is one mechanism,
      // but excluding yourself is decided by each server separately.
      const theirs = await peers(peer.url);
      expect(theirs.map((p) => p.file)).toEqual(['note.md']);
    } finally {
      peer.stop();
    }
  });

  it('carries the round and the unresolved count from the instance itself', async () => {
    const peer = await startPeer('design.md');
    try {
      await fetch(`${peer.url}/api/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startLine: 5, endLine: 5, body: 'about the heading' }),
      });
      await fetch(`${peer.url}/api/rounds`, { method: 'POST' });

      // Round 2, and the unresolved comment from round 1 still counts: closing a round
      // hands it over rather than settling it.
      expect((await peers(base))[0]).toMatchObject({ round: 2, unresolved: 1 });
    } finally {
      peer.stop();
    }
  });

  it('marks a loopback bind as unreachable instead of linking to it', async () => {
    const loopback = await startPeer('design.md');
    const lan = await startPeer('plan.md', ['--host', '0.0.0.0']);
    try {
      const rows = await peers(base);
      const byFile = Object.fromEntries(rows.map((p) => [p.file, p]));
      // The reader's browser is usually not on this host, so a peer that took the
      // default bind cannot be opened from there however the link is built.
      expect(byFile['design.md']).toMatchObject({ host: '127.0.0.1', reachable: false });
      expect(byFile['plan.md']).toMatchObject({ host: '0.0.0.0', reachable: true });
    } finally {
      loopback.stop();
      lan.stop();
    }
  });

  it('drops an entry left behind by a crash, and deletes it', async () => {
    // A crashed instance leaves its entry: no stop() ran, so nothing removed it. The pid
    // is gone, which is what tells the difference.
    const crashed = deadPid();
    mkdirSync(instancesDir(), { recursive: true });
    const entry = join(instancesDir(), `${crashed}.json`);
    writeFileSync(
      entry,
      JSON.stringify({
        pid: crashed,
        host: '127.0.0.1',
        port: 4300,
        file: join(sandbox, 'gone.md'),
        startedAt: new Date().toISOString(),
      }),
    );

    expect(await peers(base)).toEqual([]);
    expect(existsSync(entry)).toBe(false);
  });

  it('takes its entry with it when it stops', async () => {
    const peer = await startPeer('design.md');
    expect(existsSync(join(instancesDir(), `${peer.pid}.json`))).toBe(true);

    // The normal way this ends is a signal. Leaving the entry would cost every reader
    // after it a timeout on a port nobody is listening on.
    peer.stop();
    await peer.stopped;

    expect(existsSync(join(instancesDir(), `${peer.pid}.json`))).toBe(false);
    expect(await peers(base)).toEqual([]);
  });
});

/** `akapen list` reads the same registry the switcher does, from where you lost the port. */
describe('listing the instances from the terminal', () => {
  const run = (extra: string[] = []) =>
    spawnSync('bun', ['run', CLI, 'list', ...extra], {
      env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home'), AKAPEN_TOKEN: TOKEN },
      encoding: 'utf8',
    });

  it('prints the running instance as JSON, with the path in full', () => {
    const listed: unknown = JSON.parse(run(['--json']).stdout);
    expect(listed).toEqual([
      {
        pid: expect.any(Number),
        host: '127.0.0.1',
        port: Number(server!.port),
        // Somewhere to go, not the address it bound. A caller reading this to open one
        // would otherwise have to know what `0.0.0.0` means for a peer that used it.
        url: `http://127.0.0.1:${String(server!.port)}`,
        // Started with no session id, so there is nothing to attribute it to. Null
        // rather than absent: a consumer filtering on it should not have to tell the
        // two apart.
        origin: { kind: 'shell', cwd: expect.any(String) },
        // The terminal is on the host and belongs to whoever started them, unlike the
        // switcher, so here the path is the useful part.
        file: work,
        round: 1,
        unresolved: 0,
        started_at: expect.any(String),
      },
    ]);
  });

  it('prints a table with the file in it', () => {
    const out = run().stdout;
    expect(out).toContain('R001');
    expect(out).toContain(work);
  });

  it('prints a url to open, not the address the peer bound', () => {
    const out = run().stdout;
    expect(out).toContain('URL');
    expect(out).toContain(`http://127.0.0.1:${String(server!.port)}`);
    expect(out).not.toContain('ADDRESS');
  });

  it('says so when nothing is running', () => {
    const empty = spawnSync('bun', ['run', CLI, 'list'], {
      env: { ...process.env, AKAPEN_HOME: join(sandbox, 'nothing-here') },
      encoding: 'utf8',
    });
    expect(empty.stdout.trim()).toBe('no akapen is running');
    expect(
      JSON.parse(
        spawnSync('bun', ['run', CLI, 'list', '--json'], {
          env: { ...process.env, AKAPEN_HOME: join(sandbox, 'nothing-here') },
          encoding: 'utf8',
        }).stdout,
      ),
    ).toEqual([]);
  });
});

/**
 * Finding your own akapen again, from the session that started it.
 *
 * An agent starts one and the url lives in that session's scrollback and nowhere else.
 * Both halves of the fix fail quietly: an origin that is never recorded looks exactly
 * like a shell that had no session, and a url recorded on the wrong origin looks exactly
 * right until the browser is asked to come back on it and finds no cookie.
 */
describe('the session that started an instance', () => {
  const SESSION = 'f8f3b87b-e51b-4f8e-ac92-1e743787d779';
  const home = () => join(sandbox, 'home');
  const entry = (pid: number, session = SESSION) => join(home(), 'sessions', session, String(pid));
  const recorded = (pid: number, session = SESSION) =>
    existsSync(entry(pid, session)) ? readFileSync(entry(pid, session), 'utf8').trim() : null;
  const registered = (pid: number) =>
    JSON.parse(readFileSync(join(home(), 'instances', `${String(pid)}.json`), 'utf8')) as {
      origin?: { kind: string; id?: string; label?: string; cwd: string };
    };

  const startFor = (name: string, env: NodeJS.ProcessEnv, extra: string[] = []) => {
    const file = join(sandbox, name);
    writeFileSync(file, SOURCE);
    return start(file, home(), extra, { env });
  };

  it('records who started it, and where to come back to', async () => {
    const peer = await startFor('design.md', { CLAUDE_CODE_SESSION_ID: SESSION });
    try {
      expect(registered(peer.pid).origin).toMatchObject({ kind: 'claude-code', id: SESSION });
      // The url, not the bind address, and no token on it: this file is read by a
      // statusline that prints it on every redraw.
      expect(recorded(peer.pid)).toBe(`http://127.0.0.1:${peer.port}`);
      expect(recorded(peer.pid)).not.toContain('token');
    } finally {
      peer.stop();
      await peer.stopped;
    }
  });

  it('records nothing to come back to when there was no session', async () => {
    // The other direction. Without it, a test that only ever starts akapen with a session
    // cannot tell "records the right thing" from "records something regardless".
    const peer = await startFor('plan.md', {});
    try {
      expect(registered(peer.pid).origin).toMatchObject({ kind: 'shell' });
      expect(registered(peer.pid).origin?.id).toBeUndefined();
      expect(existsSync(join(home(), 'sessions'))).toBe(false);
    } finally {
      peer.stop();
      await peer.stopped;
    }
  });

  it('passes an origin label through without reading it', async () => {
    // Whoever runs akapen may have a pane id or a ticket to attach. akapen holding it as
    // an opaque string is what keeps one person's setup out of a tool anybody installs.
    const peer = await startFor('labelled.md', {
      CLAUDE_CODE_SESSION_ID: SESSION,
      AKAPEN_ORIGIN_LABEL: 'wA:p1',
    });
    try {
      expect(registered(peer.pid).origin?.label).toBe('wA:p1');
    } finally {
      peer.stop();
      await peer.stopped;
    }
  });

  it('rewrites the url to the origin a browser actually logged in on', async () => {
    const peer = await startFor('rebind.md', { CLAUDE_CODE_SESSION_ID: SESSION });
    try {
      expect(recorded(peer.pid)).toBe(`http://127.0.0.1:${peer.port}`);

      // A cookie is scoped to scheme, host and port together, so the guess above is one
      // this browser could not come back on. Logging in on it is what corrects the guess,
      // and it is why guessing is safe: a wrong guess is exactly a guess whose cookie is
      // not sent, which forces the login that fixes it.
      //
      // Written onto the socket because Host is a forbidden header name for `fetch` — a
      // version of this test using `fetch` would send the real authority and pass no
      // matter what the server recorded.
      const authority = `localhost:${peer.port}`;
      expect(await rawGet(Number(peer.port), `/?token=${TOKEN}`, authority)).toBe(302);
      await vi.waitFor(() => expect(recorded(peer.pid)).toBe(`http://${authority}`));
    } finally {
      peer.stop();
      await peer.stopped;
    }
  });

  it('does not rewrite the url for a request that failed to log in', async () => {
    const peer = await startFor('refused.md', { CLAUDE_CODE_SESSION_ID: SESSION });
    try {
      const before = recorded(peer.pid);
      // No cookie is set, so no origin became valid, so there is nothing to record. A
      // rewrite here would let anyone who can reach the port move where the session
      // thinks its own review is.
      expect(await rawGet(Number(peer.port), '/?token=wrong', `localhost:${peer.port}`)).toBe(401);
      expect(recorded(peer.pid)).toBe(before);
    } finally {
      peer.stop();
      await peer.stopped;
    }
  });

  it('records on a later login what a failed startup write did not', async () => {
    // The startup write is made impossible: a file sits where the session directory
    // belongs, so `mkdir` cannot make one. Then the obstruction is removed and the same
    // url is logged in on.
    //
    // Caching the attempt rather than the write is what this catches. The url is the one
    // startup already tried, so a cache set on the attempt makes the login return early
    // and the instance stays unrecorded for the rest of its life — with nothing on screen
    // to say so.
    mkdirSync(join(home(), 'sessions'), { recursive: true });
    writeFileSync(join(home(), 'sessions', SESSION), 'in the way');

    const peer = await startFor('retry.md', { CLAUDE_CODE_SESSION_ID: SESSION });
    try {
      rmSync(join(home(), 'sessions', SESSION));
      const authority = `127.0.0.1:${peer.port}`;
      expect(await rawGet(Number(peer.port), `/?token=${TOKEN}`, authority)).toBe(302);
      await vi.waitFor(() => expect(recorded(peer.pid)).toBe(`http://${authority}`));
    } finally {
      peer.stop();
      await peer.stopped;
    }
  });

  it('takes its own entry out when it stops, and leaves a sibling alone', async () => {
    const one = await startFor('one.md', { CLAUDE_CODE_SESSION_ID: SESSION });
    const two = await startFor('two.md', { CLAUDE_CODE_SESSION_ID: SESSION });
    try {
      expect(recorded(one.pid)).not.toBeNull();
      expect(recorded(two.pid)).not.toBeNull();

      one.stop();
      await one.stopped;

      expect(recorded(one.pid)).toBeNull();
      // The direction that is easy to get wrong: one file per instance exists so that
      // stopping one cannot take the other's with it.
      expect(recorded(two.pid)).not.toBeNull();
    } finally {
      two.stop();
      await two.stopped;
    }
  });

  it('lists only what one session started', async () => {
    const mine = await startFor('mine.md', { CLAUDE_CODE_SESSION_ID: SESSION });
    const theirs = await startFor('theirs.md', { CLAUDE_CODE_SESSION_ID: 'another-session' });
    try {
      const run = (extra: string[]) =>
        spawnSync('bun', ['run', CLI, 'list', ...extra], {
          env: { ...process.env, AKAPEN_HOME: home(), AKAPEN_TOKEN: TOKEN },
          encoding: 'utf8',
        });

      const filtered = JSON.parse(run(['--json', '--session', SESSION]).stdout) as {
        pid: number;
      }[];
      expect(filtered.map((e) => e.pid)).toContain(mine.pid);
      expect(filtered.map((e) => e.pid)).not.toContain(theirs.pid);

      // Without the filter both are there, so what is being shown is the filter working
      // and not the second instance having failed to register.
      const all = JSON.parse(run(['--json']).stdout) as { pid: number }[];
      expect(all.map((e) => e.pid)).toEqual(expect.arrayContaining([mine.pid, theirs.pid]));

      expect(run(['--session', 'nobody-started-this']).stdout.trim()).toBe('that session has none running');
    } finally {
      mine.stop();
      theirs.stop();
      await Promise.all([mine.stopped, theirs.stopped]);
    }
  });
});

/**
 * The credential, at the boundary where a stranger on the LAN becomes a reader.
 *
 * Every request here goes through `globalThis.fetch`, not the shadowed `fetch` above,
 * because what is being tested is what happens when nothing is presented — or the wrong
 * thing is.
 */
/**
 * A GET with a `Host` header of our choosing, written straight onto the socket.
 *
 * `fetch` cannot do it. Host is a forbidden header name, so the runtime drops what is
 * asked for and sends the real authority instead — which means a Host test written with
 * `fetch` passes whatever the server does, and proves nothing. The rebinding case only
 * exists for requests that lie about the header, so the request is spelled out here.
 */
function rawGet(port: number, path: string, host: string, extra: string[] = []): Promise<number> {
  return new Promise((done, fail) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        [`GET ${path} HTTP/1.1`, `Host: ${host}`, ...extra, 'Connection: close', '', ''].join('\r\n'),
      );
    });
    let buf = '';
    // Destroyed on the way out of both failure paths. Rejecting alone leaves the socket
    // open, and an open socket holds the event loop: the run would report the failure and
    // then hang instead of ending.
    socket.setTimeout(5_000, () => {
      socket.destroy();
      fail(new Error('no answer'));
    });
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
    });
    socket.on('end', () => {
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (status) done(Number(status[1]));
      else fail(new Error(`no status line in: ${buf.slice(0, 120)}`));
    });
    socket.on('error', (err) => {
      socket.destroy();
      fail(err);
    });
  });
}

describe('authentication', () => {
  const bare = (path: string, init?: RequestInit) => globalThis.fetch(`${base}${path}`, init);

  it('refuses a request with no credential', async () => {
    const res = await bare('/api/doc');
    expect(res.status).toBe(401);
    // The body has to say how to get back in, or the only way out is to find the
    // terminal the server was started from.
    expect(await res.text()).toContain('akapen token');
  });

  it('refuses the wrong token, whichever way it is presented', async () => {
    expect((await bare(`/api/doc?token=${WRONG_TOKEN}`)).status).toBe(401);
    expect((await bare('/api/doc', { headers: { authorization: `Bearer ${WRONG_TOKEN}` } })).status).toBe(
      401,
    );
  });

  it('accepts a bearer token and hands out no cookie for it', async () => {
    const res = await bare('/api/doc', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    // curl and agents keep no jar. Setting one would be a credential handed to a client
    // that never asked for it and cannot use it.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('exchanges a token in the query for a cookie and takes it out of the URL', async () => {
    const res = await bare(`/?token=${TOKEN}`, { redirect: 'manual' });
    expect(res.status).toBe(302);

    const location = res.headers.get('location') ?? '';
    // The whole point of the redirect: the address bar, the history entry and anything
    // reading the URL afterwards no longer hold the secret.
    expect(location).not.toContain(TOKEN);
    expect(location).not.toContain('token');
    // Relative, so a Host we do not serve can never be echoed back as somewhere to go.
    expect(location.startsWith('/')).toBe(true);

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('akapen_token=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // Plain HTTP: a Secure cookie would never be stored, so the redirect would loop.
    expect(cookie).not.toContain('Secure');
  });

  it('takes the token back out of the URL on every visit, not only the first', async () => {
    /**
     * The bookmark keeps its `?token=` on purpose, so it is opened again and again by a
     * browser that already has the cookie. Answering on the cookie and stopping there
     * would put the secret back in the address bar and in a new history entry each time
     * — the redirect would only ever have worked once, on the very first visit.
     */
    const cookie = `akapen_token=${TOKEN}`;
    const res = await bare(`/?token=${TOKEN}`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('never redirects to somewhere that is not this server', async () => {
    /**
     * `//evil.example/x` is a scheme-relative URL, not a path: a browser sent there
     * leaves for `evil.example`. A request for `GET //evil.example/x?token=...` produces
     * exactly that pathname, so echoing it back turned this redirect into an open one.
     * The token is stripped by then, so nothing leaks — the reader just lands somewhere
     * chosen by whoever sent them the link.
     */
    const cookie = `akapen_token=${TOKEN}`;
    for (const path of ['//evil.example/x', '///evil.example/x', '////a']) {
      const res = await bare(`${path}?token=${TOKEN}`, { headers: { cookie }, redirect: 'manual' });
      const location = res.headers.get('location') ?? '';
      // One leading slash is a path on this server, which is all a redirect here should
      // ever be. Two is an authority, and the name after it is where the browser goes.
      // The name surviving as a path segment is not a leak — `/evil.example/x` is just a
      // path akapen does not serve.
      expect(location.startsWith('/'), `${path} -> ${location}`).toBe(true);
      expect(location.startsWith('//'), `${path} -> ${location}`).toBe(false);
    }
  });

  it('strips a stale token without storing it, when the cookie is still good', async () => {
    // A bookmark from before a rotation, opened by a browser whose cookie still works.
    // It gets in on the cookie, and the dead value is taken out of the URL rather than
    // written over the credential that is working.
    const cookie = `akapen_token=${TOKEN}`;
    const res = await bare(`/?token=${WRONG_TOKEN}`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('keeps a token in the query working as a credential on a write', async () => {
    // Redirecting a POST would lose its body, so a query token on one is read as a
    // credential rather than as something somebody is about to bookmark.
    const res = await bare(`/api/comments?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine: 5, endLine: 5, body: 'posted with a query token' }),
    });
    expect(res.status).toBe(200);
  });

  it('lets the cookie alone carry the whole surface, SSE included', async () => {
    const cookie = `akapen_token=${TOKEN}`;
    expect((await bare('/api/doc', { headers: { cookie } })).status).toBe(200);
    expect((await bare('/api/comments', { headers: { cookie } })).status).toBe(200);

    // EventSource cannot set headers, so the cookie is the only credential SSE will ever
    // have. If this ever needs one, live updates are gone.
    const ctrl = new AbortController();
    const res = await globalThis.fetch(`${base}/events`, {
      headers: { cookie },
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    ctrl.abort();
  });

  it('accepts the scheme however it is capitalised, and says which one it wanted', async () => {
    // RFC 7235 §2.1: the scheme is case-insensitive, so a client sending `bearer` is
    // right and a 401 in reply would be ours to explain.
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      expect(
        (await bare('/api/doc', { headers: { authorization: `${scheme} ${TOKEN}` } })).status,
        scheme,
      ).toBe(200);
    }
    // RFC 7235 §3.1: a 401 names the scheme that would have worked.
    expect((await bare('/api/doc')).headers.get('www-authenticate')).toBe('Bearer');
  });

  it('gives the cookie a life longer than the browser window', async () => {
    // A session cookie would mean logging in again after every browser restart, which is
    // the whole thing this flow exists to remove. The token behind it does not expire, so
    // an expiry here would be asking again rather than protecting anything.
    const res = await bare(`/?token=${TOKEN}`, { redirect: 'manual' });
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=\d{6,}/i);
  });

  it('sets the referrer policy on every answer, including the ones it refuses', async () => {
    // The token rides in a URL, and the two answers that would miss it are exactly the
    // ones built outside the JSON handlers: the host refusal, and the SSE stream.
    expect((await bare('/api/doc')).headers.get('referrer-policy')).toBe('no-referrer');

    const ctrl = new AbortController();
    const events = await globalThis.fetch(`${base}/events`, {
      headers: { cookie: `akapen_token=${TOKEN}` },
      signal: ctrl.signal,
    });
    expect(events.headers.get('referrer-policy')).toBe('no-referrer');
    ctrl.abort();
  });

  it('refuses a write that came from another page, cookie and all', async () => {
    /**
     * The cross-port case, which the cookie cannot tell apart on its own.
     *
     * Cookies are not isolated by port and neither is `SameSite`, so a page on another
     * port of this host is the same *site* and the browser attaches akapen's cookie to
     * its requests. `POST` with no body needs no preflight, so nothing else is in the
     * way: without this check a page on `localhost:8080` cuts a round here.
     */
    const cookie = `akapen_token=${TOKEN}`;
    const from = (site: string) =>
      bare('/api/rounds', { method: 'POST', headers: { cookie, 'sec-fetch-site': site } });

    expect((await from('cross-site')).status).toBe(403);
    expect((await from('same-site')).status).toBe(403);

    // Reads are left alone: without CORS headers the answer cannot be read back, and a
    // GET changes nothing whether it can be or not.
    expect((await bare('/api/doc', { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(
      200,
    );
  });

  it("lets akapen's own page write, and lets a client that is not a browser write", async () => {
    const cookie = `akapen_token=${TOKEN}`;
    // What the browser sends for akapen's own fetch.
    expect(
      (
        await bare('/api/comments', {
          method: 'POST',
          headers: { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
          body: JSON.stringify({ startLine: 5, endLine: 5, body: 'from the page itself' }),
        })
      ).status,
    ).toBe(200);

    // curl and agents send no Sec-Fetch-* at all, and carry a bearer token instead.
    expect(
      (
        await bare('/api/comments', {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ startLine: 5, endLine: 5, body: 'from an agent' }),
        })
      ).status,
    ).toBe(200);
  });

  it('serves a name spelled with the root dot', async () => {
    // `localhost.` is `localhost` with the root of the DNS tree written out. Clients do
    // send it, and a 403 there is a refusal with nothing wrong on the other end.
    const port = Number(server!.port);
    expect(await rawGet(port, '/api/doc', `localhost.:${port}`, [`Authorization: Bearer ${TOKEN}`])).toBe(
      200,
    );
  });

  it('refuses a Host it does not serve, even holding a valid token', async () => {
    // DNS rebinding: the browser believes akapen is the attacker's origin and attaches
    // the cookie itself, so the token proves nothing here. The Host is the only part of
    // the request a page cannot choose.
    const port = Number(server!.port);
    const bearer = `Authorization: Bearer ${TOKEN}`;
    expect(await rawGet(port, '/api/doc', 'attacker.example', [bearer])).toBe(403);
    // A port on the end changes nothing: it is the name that is checked, and cookies are
    // not isolated by port anyway (RFC 6265 §8.5).
    expect(await rawGet(port, '/api/doc', `attacker.example:${port}`, [bearer])).toBe(403);
  });

  it('serves the names this host really answers to', async () => {
    const port = Number(server!.port);
    const bearer = `Authorization: Bearer ${TOKEN}`;
    for (const host of ['localhost', `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port}`]) {
      expect(await rawGet(port, '/api/doc', host, [bearer]), host).toBe(200);
    }
  });

  it('serves nothing without a credential when the token is only in the store', async () => {
    // No AKAPEN_TOKEN in the environment: the server generates one and writes it, so the
    // reader has to have been told. This is the everyday case.
    const home = join(sandbox, 'generated-home');
    const note = join(sandbox, 'generated.md');
    writeFileSync(note, SOURCE);
    const other = await start(note, home, [], { token: null });
    try {
      expect((await globalThis.fetch(`${other.url}/api/doc`)).status).toBe(401);
      const stored = readFileSync(join(home, 'token'), 'utf8').trim();
      expect(stored.length).toBeGreaterThan(20);
      expect(
        (
          await globalThis.fetch(`${other.url}/api/doc`, {
            headers: { authorization: `Bearer ${stored}` },
          })
        ).status,
      ).toBe(200);
      // The one file that must not be readable by anyone else on the host.
      expect(statSync(join(home, 'token')).mode & 0o777).toBe(0o600);
    } finally {
      other.stop();
      await other.stopped;
    }
  });

  it('stops accepting the old token once the stored one is rotated', async () => {
    /**
     * Rotation is the only revocation there is, so it has to reach the servers that are
     * already running. Reading the token once at startup would leave every open cookie
     * and every script holding the old one working until each instance was restarted —
     * revoking nothing, at the moment somebody had decided to revoke.
     *
     * Started without AKAPEN_TOKEN, because a token handed in is pinned on purpose.
     */
    const home = join(sandbox, 'rotating-home');
    const note = join(sandbox, 'rotating.md');
    writeFileSync(note, SOURCE);
    const running = await start(note, home, [], { token: null });
    try {
      const before = readFileSync(join(home, 'token'), 'utf8').trim();
      const bearer = (t: string) =>
        globalThis.fetch(`${running.url}/api/doc`, { headers: { authorization: `Bearer ${t}` } });
      expect((await bearer(before)).status).toBe(200);

      // execFileSync, not execSync: CLI is a path built from this file's own location,
      // and a checkout under a directory with a space in it would otherwise arrive as
      // two arguments.
      const after = execFileSync('bun', ['run', CLI, 'token', '--rotate'], {
        env: { ...process.env, AKAPEN_HOME: home },
        encoding: 'utf8',
      }).trim();
      expect(after).not.toBe(before);

      // The server re-reads on an interval rather than per request, so give it one.
      await new Promise((r) => setTimeout(r, 1_200));

      expect((await bearer(after)).status).toBe(200);
      expect((await bearer(before)).status).toBe(401);
    } finally {
      running.stop();
      await running.stopped;
    }
  });

  it('keeps a token it was handed, whatever the store says afterwards', async () => {
    // The other half of the rule: `--token` and `AKAPEN_TOKEN` belong to whoever passed
    // them, and a rotation on this host is not theirs to be told about.
    const home = join(sandbox, 'pinned-home');
    const note = join(sandbox, 'pinned.md');
    writeFileSync(note, SOURCE);
    const running = await start(note, home, [], { token: 'pinned-for-this-run' });
    try {
      execFileSync('bun', ['run', CLI, 'token', '--rotate'], {
        env: { ...process.env, AKAPEN_HOME: home },
        encoding: 'utf8',
      });
      await new Promise((r) => setTimeout(r, 1_200));
      expect(
        (
          await globalThis.fetch(`${running.url}/api/doc`, {
            headers: { authorization: 'Bearer pinned-for-this-run' },
          })
        ).status,
      ).toBe(200);
    } finally {
      running.stop();
      await running.stopped;
    }
  });

  it('serves without a credential only when asked to', async () => {
    const open = join(sandbox, 'open.md');
    writeFileSync(open, SOURCE);
    const served = await start(open, join(sandbox, 'open-home'), ['--no-auth']);
    try {
      expect((await globalThis.fetch(`${served.url}/api/doc`)).status).toBe(200);
      // The Host check is not part of the credential and stays on regardless: it answers
      // a different question, and `--no-auth` is about who may connect, not about which
      // origin a browser thinks it is talking to.
      expect(await rawGet(Number(served.port), '/api/doc', 'attacker.example')).toBe(403);
    } finally {
      served.stop();
      await served.stopped;
    }
  });
});
