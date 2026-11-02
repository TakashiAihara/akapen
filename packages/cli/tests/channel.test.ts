/**
 * What the channel pushes into a session.
 *
 * Four ways this fails quietly, and all four look identical from the session's side —
 * nothing arrives, or something arrives that should not have. Pushing a sibling
 * session's comments puts a document the reader never opened in front of them. Pushing
 * the backlog at startup buries the one comment that is new under everything already
 * handed over by `akapen comments`. Counting instead of naming re-fires on the same
 * unresolved comment every pass, forever. And the quietest: a handshake that negotiates
 * the modern protocol revision, so Claude Code never registers the channel at all.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collect,
  filesForSession,
  fingerprint,
  askInstructions,
  idsOf,
  INSTRUCTIONS,
  instructionsEvent,
  markSent,
  newEvents,
  type ChannelEvent,
  type Loaded,
} from '../src/channel.ts';
import { openRound, saveComments } from '@akapen/core/store';
import type { RoundComment } from '@akapen/shared';

const comment = (id: string, over: Partial<RoundComment> = {}): RoundComment => ({
  id,
  startLine: 3,
  endLine: 3,
  body: `body of ${id}`,
  author: 'root',
  createdAt: '2026-09-18T00:00:00.000Z',
  resolved: false,
  anchor: '## A heading',
  round: 1,
  replies: [],
  ...over,
});

const reply = (id: string) => ({
  id,
  body: `reply ${id}`,
  author: 'root',
  authorKind: 'human' as const,
  createdAt: '2026-09-18T00:00:00.000Z',
});

describe('filesForSession', () => {
  it("takes the documents this session started, and nobody else's", () => {
    const records = [
      { file: '/n/mine.md', origin: { id: 'S1' } },
      { file: '/n/theirs.md', origin: { id: 'S2' } },
      { file: '/n/shell.md' },
    ];
    expect(filesForSession(records, 'S1')).toEqual(['/n/mine.md']);
  });

  it('names a document once however many instances serve it', () => {
    const records = [
      { file: '/n/mine.md', origin: { id: 'S1' } },
      { file: '/n/mine.md', origin: { id: 'S1' } },
    ];
    expect(filesForSession(records, 'S1')).toEqual(['/n/mine.md']);
  });
});

describe('idsOf', () => {
  it('names replies as well as comments', () => {
    expect(idsOf([comment('c1', { replies: [reply('r1'), reply('r2')] })])).toEqual(['c1', 'c1/r1', 'c1/r2']);
  });
});

describe('newEvents', () => {
  it('says nothing about a document it is seeing for the first time', () => {
    const { events, known } = newEvents('/n/a.md', [comment('c1'), comment('c2')], undefined);
    expect(events).toEqual([]);
    expect([...known]).toEqual(['c1', 'c2']);
  });

  it('seeds the replies that were already on it, not only the comments', () => {
    const before = [comment('c1', { replies: [reply('r1')] })];
    const first = newEvents('/n/a.md', before, undefined);
    expect(first.events).toEqual([]);
    // Without the replies in `known`, r1 reads as new on the pass after the first one.
    expect(newEvents('/n/a.md', before, first.known).events).toEqual([]);
  });

  it('reports a comment that was not there before', () => {
    const first = newEvents('/n/a.md', [comment('c1')], undefined);
    const { events } = newEvents('/n/a.md', [comment('c2'), comment('c1')], first.known);
    expect(events).toHaveLength(1);
    expect(events[0]?.meta['comment_id']).toBe('c2');
    expect(events[0]?.content).toContain('body of c2');
  });

  it('reports a reply on a comment it has already reported', () => {
    const first = newEvents('/n/a.md', [comment('c1')], undefined);
    const { events } = newEvents('/n/a.md', [comment('c1', { replies: [reply('r1')] })], first.known);
    expect(events).toHaveLength(1);
    expect(events[0]?.meta['reply_id']).toBe('r1');
    expect(events[0]?.content).toContain('reply r1');
    // The comment it answers, so the thread reads without going back to the store.
    expect(events[0]?.content).toContain('body of c1');
  });

  it('carries the author field akapen stored, as akapen comments does', () => {
    const first = newEvents('/n/a.md', [], undefined);
    const { events } = newEvents('/n/a.md', [comment('c1', { author: 'takashi' })], first.known);
    expect(events[0]?.meta['author']).toBe('takashi');
  });

  it('does not push a file again after a read that came back empty', () => {
    const first = newEvents('/n/a.md', [comment('c1')], undefined);
    const empty = newEvents('/n/a.md', [], first.known);
    // Resolving everything and opening one again looks the same from here.
    const back = newEvents('/n/a.md', [comment('c1')], empty.known);
    expect(back.events).toEqual([]);
  });

  it('does not report the same unresolved comment twice', () => {
    const first = newEvents('/n/a.md', [comment('c1')], undefined);
    const second = newEvents('/n/a.md', [comment('c2'), comment('c1')], first.known);
    const third = newEvents('/n/a.md', [comment('c2'), comment('c1')], second.known);
    expect(third.events).toEqual([]);
  });

  it('reports a comment that arrived while another was resolved', () => {
    // The set is the same size either side, so anything watching how many are pending
    // sees nothing happen. Resolving one and writing one is an ordinary minute of use.
    const first = newEvents('/n/a.md', [comment('c1')], undefined);
    const { events } = newEvents('/n/a.md', [comment('c3')], first.known);
    expect(events).toHaveLength(1);
    expect(events[0]?.meta['comment_id']).toBe('c3');
  });

  it('carries the anchor, because line numbers belong to the round', () => {
    const first = newEvents('/n/a.md', [], undefined);
    const { events } = newEvents('/n/a.md', [comment('c1', { anchor: '### Q-04 something' })], first.known);
    expect(events[0]?.content).toContain('### Q-04 something');
  });

  it('keys meta by identifiers, which is all Claude Code keeps', () => {
    const first = newEvents('/n/a.md', [], undefined);
    // Both shapes: a hyphen in a key is dropped in silence, and `reply_id` only appears
    // on the reply path, so checking the comment path alone would never see it.
    const { events } = newEvents('/n/a.md', [comment('c1', { replies: [reply('r1')] })], first.known);
    expect(events).toHaveLength(2);
    const keys = events.flatMap((e) => Object.keys(e.meta));
    expect(keys).toContain('reply_id');
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

/** A store on no disk: what each pass sees is whatever the case hands it. */
const store = (files: string[], comments: Record<string, RoundComment[] | Error>) => ({
  instances: () => files.map((file) => ({ file, host: '0.0.0.0', port: 4314, origin: { id: 'S1' } })),
  comments: (file: string) => {
    const c = comments[file];
    if (c instanceof Error) throw c;
    return c ?? [];
  },
});

describe('collect', () => {
  it('says where to reply, on this host', () => {
    const seen = new Map<string, Set<string>>();
    collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [] }));
    const events = collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1')] }));
    expect(events[0]?.meta['url']).toBe('http://127.0.0.1:4314');
  });

  it('sends an event again when its delivery failed', () => {
    const seen = new Map<string, Set<string>>();
    collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [] }));
    expect(collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1')] }))).toHaveLength(1);
    // Not marked: the notification threw, so the session never saw it.
    expect(collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1')] }))).toHaveLength(1);
  });

  it('does not send a delivered event again', () => {
    const seen = new Map<string, Set<string>>();
    collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [] }));
    const withReply = [comment('c1', { replies: [reply('r1')] })];
    const first = collect('S1', seen, store(['/n/a.md'], { '/n/a.md': withReply }));
    expect(first).toHaveLength(2);
    for (const e of first) markSent(seen, e);
    expect(collect('S1', seen, store(['/n/a.md'], { '/n/a.md': withReply }))).toEqual([]);
  });

  it("does not push this session's own reply back to it, and still pushes everyone else's", () => {
    const seen = new Map<string, Set<string>>();
    collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1')] }));
    const replies = [
      { ...reply('sibling'), sessionId: 'S2' },
      { ...reply('mine'), sessionId: 'S1' },
      reply('person'),
    ];
    const events = collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1', { replies })] }));
    expect(events.map((e) => e.meta['reply_id'])).toEqual(['sibling', 'person']);
    // Never marked sent, so the filter is what holds it back on every later pass too.
    for (const e of events) markSent(seen, e);
    expect(collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1', { replies })] }))).toEqual([]);
  });

  it('forgets a document whose akapen has stopped', () => {
    const seen = new Map<string, Set<string>>();
    collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1')] }));
    collect('S1', seen, store([], {}));
    expect([...seen.keys()]).toEqual([]);
  });

  it('keeps what it knew when a store cannot be read, rather than seeding over it', () => {
    const seen = new Map<string, Set<string>>();
    collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1')] }));
    collect('S1', seen, store(['/n/a.md'], { '/n/a.md': new Error('mid-write') }));
    // c2 was written while the store could not be read. Forgetting the file over that
    // pass makes the next one a first sight, and c2 is seeded as history instead.
    const events = collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1'), comment('c2')] }));
    expect(events).toHaveLength(1);
    expect(events[0]?.meta['comment_id']).toBe('c2');
  });

  it('does not go quiet when the registry cannot be read', () => {
    const seen = new Map<string, Set<string>>();
    collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1')] }));
    const broken = {
      instances: (): never => {
        throw new Error('mid-write');
      },
      comments: () => [],
    };
    expect(collect('S1', seen, broken)).toEqual([]);
    const events = collect('S1', seen, store(['/n/a.md'], { '/n/a.md': [comment('c1'), comment('c2')] }));
    expect(events).toHaveLength(1);
  });
});

describe('runChannel', () => {
  it('exits when the session closes its stdin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'akapen-channel-'));
    const cli = join(import.meta.dirname, '../src/cli.ts');
    const proc = spawn('bun', ['run', cli, 'channel'], {
      env: { ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: 'channel-exit-test' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    try {
      // Long enough for the MCP transport to be listening, so the close is what ends it.
      await new Promise((r) => setTimeout(r, 1500));
      expect(proc.exitCode).toBeNull();
      const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
      proc.stdin.end();
      const code = await Promise.race([
        exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000)),
      ]);
      expect(code).toBe(0);
    } finally {
      proc.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  it('exits 2 and says why when no session spawned it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'akapen-channel-'));
    const env: NodeJS.ProcessEnv = { ...process.env, AKAPEN_HOME: home };
    delete env['CLAUDE_CODE_SESSION_ID'];
    const ch = startChannel(env);
    try {
      expect(await within(ch.exited, 10_000)).toBe(2);
      expect(ch.stderr()).toContain('channel needs CLAUDE_CODE_SESSION_ID');
      // stdout is the JSON-RPC stream Claude Code reads; the reason goes to stderr only.
      expect(ch.stdout()).toBe('');
    } finally {
      ch.proc.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  it('writes a notification to stdout for a comment that lands while it runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'akapen-channel-'));
    const doc = reviewing(home);
    const ch = startChannel({ ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION });
    try {
      // The initialize answer comes after the first pass, which is the one that seeds what is
      // already there.
      await handshake(ch);
      inHome(home, () => saveComments(doc, 1, [comment('c-old'), comment('c-new')]));
      const event = await ch.waitFor((m) => m['method'] === 'notifications/claude/channel', 10_000);
      const params = event['params'] as ChannelEvent;
      expect(params.meta['comment_id']).toBe('c-new');
      expect(params.meta['file']).toBe(doc);
      expect(params.content).toContain('body of c-new');
      // A comment written after c-new arrived is delivered by a later pass, which is one that
      // would send c-new again had its delivery not been recorded. The backlog it was started
      // with is never pushed.
      inHome(home, () => saveComments(doc, 1, [comment('c-old'), comment('c-new'), comment('c-later')]));
      await ch.waitFor(
        (m) => (m['params'] as ChannelEvent | undefined)?.meta['comment_id'] === 'c-later',
        10_000,
      );
      expect(ch.notifications().map((n) => n.meta['comment_id'])).toEqual(['c-new', 'c-later']);
      expect(ch.garbage()).toEqual([]);
    } finally {
      ch.proc.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 25000);

  it('keeps running, and keeps delivering, after a pass that throws', async () => {
    const home = mkdtempSync(join(tmpdir(), 'akapen-channel-'));
    const doc = reviewing(home);
    const ch = startChannel({ ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION });
    try {
      await handshake(ch);
      // Replies that are not a list make naming the thread throw inside the pass.
      const broken = { ...comment('c-broken'), replies: 5 } as unknown as RoundComment;
      inHome(home, () => saveComments(doc, 1, [comment('c-old'), broken]));
      await ch.waitForStderr('akapen: channel pass failed:', 10_000);
      expect(ch.proc.exitCode).toBeNull();

      inHome(home, () => saveComments(doc, 1, [comment('c-old'), comment('c-new')]));
      const event = await ch.waitFor((m) => m['method'] === 'notifications/claude/channel', 10_000);
      expect((event['params'] as ChannelEvent).meta['comment_id']).toBe('c-new');
      expect(ch.proc.exitCode).toBeNull();
      expect(ch.garbage()).toEqual([]);
    } finally {
      ch.proc.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 25000);
});

describe('the handshake Claude Code registers a channel on', () => {
  // Spelled out rather than taken from the SDK: the point is to fail when a new SDK moves.
  const LEGACY = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

  // tests/repo/dependabot.test.ts checks that Dependabot raises a bump of it on its own.
  it('pins the SDK to an exact version', () => {
    // A range lets `bun update` move it inside the range without anyone choosing that release.
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('negotiates a legacy protocol revision, even when the client offers the modern one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'akapen-channel-'));
    const ch = startChannel({ ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION });
    try {
      const result = await handshake(ch, '2026-07-28');
      expect(LEGACY).toContain(result['protocolVersion']);
      expect(ch.garbage()).toEqual([]);
    } finally {
      ch.proc.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  // No other on purpose: an experimental capability is something Claude Code acts on, so a
  // new one should be a decision someone makes here, not something an SDK bump adds.
  it('declares the channel capability and no other', async () => {
    const home = mkdtempSync(join(tmpdir(), 'akapen-channel-'));
    const ch = startChannel({ ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION });
    try {
      const result = await handshake(ch);
      const experimental = (result['capabilities'] as { experimental?: Record<string, unknown> })
        .experimental;
      expect(Object.keys(experimental ?? {})).toEqual(['claude/channel']);
      expect(ch.garbage()).toEqual([]);
    } finally {
      ch.proc.kill();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  // Both orders, so a server that answers it only before, or only after, the connection is
  // initialised still fails.
  it.each(['before', 'after'] as const)(
    'does not answer server/discover asked %s initialize',
    async (when) => {
      const home = mkdtempSync(join(tmpdir(), 'akapen-channel-'));
      const ch = startChannel({ ...process.env, AKAPEN_HOME: home, CLAUDE_CODE_SESSION_ID: SESSION });
      try {
        if (when === 'after') await handshake(ch);
        ch.send({ jsonrpc: '2.0', id: 2, method: 'server/discover', params: {} });
        const answer = await ch.waitFor((m) => m['id'] === 2, 10_000);
        expect(answer['result']).toBeUndefined();
        // -32601: method not found.
        expect((answer['error'] as { code?: number }).code).toBe(-32601);
        expect(ch.garbage()).toEqual([]);
      } finally {
        ch.proc.kill();
        rmSync(home, { recursive: true, force: true });
      }
    },
    15000,
  );
});

const SESSION = 'channel-lifecycle-test';

type Message = Record<string, unknown>;

type Running = {
  proc: ChildProcessWithoutNullStreams;
  exited: Promise<number | null>;
  send: (m: Message) => void;
  waitFor: (pred: (m: Message) => boolean, ms: number) => Promise<Message>;
  waitForStderr: (text: string, ms: number) => Promise<void>;
  notifications: () => ChannelEvent[];
  garbage: () => string[];
  stdout: () => string;
  stderr: () => string;
};

/** `akapen channel` with its stdio held the way Claude Code holds it: line-delimited JSON-RPC. */
function startChannel(env: NodeJS.ProcessEnv): Running {
  const cli = join(import.meta.dirname, '../src/cli.ts');
  const proc = spawn('bun', ['run', cli, 'channel'], { env, stdio: 'pipe' });
  const messages: Message[] = [];
  // Lines that are not JSON. Anything else on stdout breaks the stream Claude Code reads, so
  // the waiting test fails on it, naming the line.
  const garbage: string[] = [];
  let raw = '';
  let out = '';
  let err = '';
  // Read from the start, so a full pipe never stalls the child.
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    raw += chunk;
    out += chunk;
    for (let i = out.indexOf('\n'); i >= 0; i = out.indexOf('\n')) {
      const line = out.slice(0, i).trim();
      out = out.slice(i + 1);
      if (line === '') continue;
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        garbage.push(line);
      }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    err += chunk;
  });
  // `close`, not `exit`: it waits for stdout and stderr to drain, so a line written just
  // before exiting is in `raw` by the time the exit code is read.
  const exited = new Promise<number | null>((r) => proc.on('close', (code) => r(code)));
  const poll = async <T>(found: () => T | undefined, ms: number, what: string): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (garbage.length > 0) throw new Error(`not JSON-RPC on stdout: ${garbage[0]}`);
      const hit = found();
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; stderr: ${err}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return {
    proc,
    exited,
    send: (m) => proc.stdin.write(`${JSON.stringify(m)}\n`),
    waitFor: (pred, ms) => poll(() => messages.find(pred), ms, 'a message'),
    waitForStderr: (text, ms) => poll(() => (err.includes(text) ? true : undefined), ms, text).then(() => {}),
    garbage: () => [...garbage],
    notifications: () =>
      messages
        .filter((m) => m['method'] === 'notifications/claude/channel')
        .map((m) => m['params'] as ChannelEvent),
    stdout: () => raw,
    stderr: () => err,
  };
}

/** The initialize exchange, answered and acknowledged. Returns what the server answered. */
async function handshake(ch: Running, protocolVersion = '2025-06-18'): Promise<Message> {
  ch.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'channel-test', version: '0.0.0' } },
  });
  const answer = await ch.waitFor((m) => m['id'] === 1, 10_000);
  ch.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return answer['result'] as Message;
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

function inHome<T>(home: string, fn: () => T): T {
  const before = process.env['AKAPEN_HOME'];
  process.env['AKAPEN_HOME'] = home;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env['AKAPEN_HOME'];
    else process.env['AKAPEN_HOME'] = before;
  }
}

/**
 * A document this session's akapen is serving, with one comment already on it.
 *
 * The instance entry names the test's own pid, which is alive, so the channel takes it as
 * a running akapen without one being started.
 */
function reviewing(home: string): string {
  const doc = join(home, 'doc.md');
  writeFileSync(doc, '# Doc\n');
  inHome(home, () => {
    openRound(doc, '# Doc\n');
    saveComments(doc, 1, [comment('c-old')]);
  });
  mkdirSync(join(home, 'instances'), { recursive: true });
  const record = {
    pid: process.pid,
    host: '127.0.0.1',
    port: 4300,
    file: doc,
    startedAt: new Date().toISOString(),
    origin: { kind: 'claude-code', cwd: home, id: SESSION },
  };
  writeFileSync(join(home, 'instances', `${process.pid}.json`), JSON.stringify(record));
  return doc;
}

describe('the store the channel reads by default', () => {
  it('leaves registry entries it cannot use where they are (#184)', () => {
    const home = mkdtempSync(join(tmpdir(), 'akapen-channel-'));
    const before = process.env['AKAPEN_HOME'];
    process.env['AKAPEN_HOME'] = home;
    try {
      mkdirSync(join(home, 'instances'), { recursive: true });
      // What a newer binary might write and this one cannot read, for a live process.
      const foreign = `${process.ppid}.json`;
      writeFileSync(join(home, 'instances', foreign), '{"shape":"from a later version"}');

      expect(collect('channel-sweep-test', new Map())).toEqual([]);
      expect(readdirSync(join(home, 'instances'))).toEqual([foreign]);
    } finally {
      if (before === undefined) delete process.env['AKAPEN_HOME'];
      else process.env['AKAPEN_HOME'] = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'akapen-replaced-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const reads = (answer: string | null) => {
  const calls: number[] = [];
  return { calls, read: () => (calls.push(1), answer) };
};

describe('handing the session new instructions after an update (#248)', () => {
  const OLD = 'old instructions';
  const NEW = 'new instructions';
  const started = (paths: string[]): Loaded => ({ files: fingerprint(paths), instructions: OLD });

  it('asks nothing while every file is the one it started from', () => {
    withDir((dir) => {
      const bin = join(dir, 'akapen');
      writeFileSync(bin, 'old');
      const r = reads(NEW);
      const out = instructionsEvent(started([bin]), fingerprint([bin]), r.read);
      expect(out.event).toBeUndefined();
      expect(r.calls).toHaveLength(0);
    });
  });

  it('carries the new instructions once an install renamed a binary over it', () => {
    withDir((dir) => {
      const bin = join(dir, 'akapen');
      writeFileSync(bin, 'old');
      const loaded = started([bin]);
      writeFileSync(join(dir, 'next'), 'new');
      renameSync(join(dir, 'next'), bin);
      const out = instructionsEvent(loaded, fingerprint([bin]), reads(NEW).read);
      expect(out.event?.meta).toEqual({ event: 'instructions' });
      expect(out.event?.content).toContain(`\n\n${NEW}`);
      // Told once: the next pass compares against what it just sent.
      const again = reads(NEW);
      expect(instructionsEvent(out.loaded, fingerprint([bin]), again.read).event).toBeUndefined();
      expect(again.calls).toHaveLength(0);
    });
  });

  it('notices a change in the second file it watches, as a pull from source makes', () => {
    withDir((dir) => {
      const [bun, source] = [join(dir, 'bun'), join(dir, 'channel.ts')];
      writeFileSync(bun, 'bun');
      writeFileSync(source, 'a');
      const loaded = started([bun, source]);
      writeFileSync(join(dir, 'next'), 'b');
      renameSync(join(dir, 'next'), source);
      expect(instructionsEvent(loaded, fingerprint([bun, source]), reads(NEW).read).event).toBeDefined();
    });
  });

  it('stays quiet when the update left the instructions as they were, and stops asking', () => {
    withDir((dir) => {
      const bin = join(dir, 'akapen');
      writeFileSync(bin, 'old');
      const loaded = started([bin]);
      writeFileSync(join(dir, 'next'), 'new');
      renameSync(join(dir, 'next'), bin);
      const out = instructionsEvent(loaded, fingerprint([bin]), reads(OLD).read);
      expect(out.event).toBeUndefined();
      const again = reads(NEW);
      expect(instructionsEvent(out.loaded, fingerprint([bin]), again.read).event).toBeUndefined();
      expect(again.calls).toHaveLength(0);
    });
  });

  it('asks again a minute after a failed read, not on every pass, with nothing else changing', () => {
    withDir((dir) => {
      const bin = join(dir, 'akapen');
      writeFileSync(bin, 'old');
      const loaded = started([bin]);
      writeFileSync(join(dir, 'next'), 'new');
      renameSync(join(dir, 'next'), bin);
      const failed = instructionsEvent(loaded, fingerprint([bin]), reads(null).read, 1_000_000);
      expect(failed.event).toBeUndefined();
      expect(failed.loaded.instructions).toBe(OLD);
      const soon = reads(NEW);
      expect(
        instructionsEvent(failed.loaded, fingerprint([bin]), soon.read, 1_059_999).event,
      ).toBeUndefined();
      expect(soon.calls).toHaveLength(0);
      const later = instructionsEvent(failed.loaded, fingerprint([bin]), reads(NEW).read, 1_060_000);
      expect(later.event?.content).toContain(NEW);
    });
  });

  it('says nothing about a later install that keeps the instructions it already sent', () => {
    withDir((dir) => {
      const bin = join(dir, 'akapen');
      writeFileSync(bin, 'v1');
      const first = started([bin]);
      writeFileSync(join(dir, 'next'), 'v2');
      renameSync(join(dir, 'next'), bin);
      const sent = instructionsEvent(first, fingerprint([bin]), reads(NEW).read);
      expect(sent.event).toBeDefined();
      writeFileSync(join(dir, 'next'), 'v3');
      renameSync(join(dir, 'next'), bin);
      expect(instructionsEvent(sent.loaded, fingerprint([bin]), reads(NEW).read).event).toBeUndefined();
    });
  });

  it('keeps the mark of a file it could not read, so its return still counts', () => {
    withDir((dir) => {
      const [bun, source] = [join(dir, 'bun'), join(dir, 'channel.ts')];
      writeFileSync(bun, 'bun');
      writeFileSync(source, 'a');
      const loaded = started([bun, source]);
      writeFileSync(join(dir, 'next'), 'bun2');
      renameSync(join(dir, 'next'), bun);
      rmSync(source);
      const quiet = instructionsEvent(loaded, fingerprint([bun, source]), reads(OLD).read);
      writeFileSync(source, 'b');
      expect(
        instructionsEvent(quiet.loaded, fingerprint([bun, source]), reads(NEW).read).event,
      ).toBeDefined();
    });
  });

  it('sees a rename even when the new file keeps the old size and mtime', () => {
    withDir((dir) => {
      const bin = join(dir, 'akapen');
      writeFileSync(bin, 'old');
      const loaded = started([bin]);
      const { atime, mtime } = statSync(bin);
      writeFileSync(join(dir, 'next'), 'new');
      utimesSync(join(dir, 'next'), atime, mtime);
      renameSync(join(dir, 'next'), bin);
      expect(instructionsEvent(loaded, fingerprint([bin]), reads(NEW).read).event).toBeDefined();
    });
  });

  it('sees a write in place, which keeps the inode', () => {
    withDir((dir) => {
      const bin = join(dir, 'akapen');
      writeFileSync(bin, 'old');
      utimesSync(bin, 1, 1);
      const loaded = started([bin]);
      writeFileSync(bin, 'new');
      expect(instructionsEvent(loaded, fingerprint([bin]), reads(NEW).read).event).toBeDefined();
    });
  });

  it('waits while the binary is missing, rather than asking a half-done install', () => {
    withDir((dir) => {
      const bin = join(dir, 'akapen');
      writeFileSync(bin, 'old');
      const loaded = started([bin]);
      rmSync(bin);
      const r = reads(NEW);
      expect(instructionsEvent(loaded, fingerprint([bin]), r.read).event).toBeUndefined();
      expect(r.calls).toHaveLength(0);
    });
  });
});

describe('asking the akapen on disk for its instructions (#248)', () => {
  const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

  it('gets exactly what this version hands over at the handshake', () => {
    // bun by name: vitest runs under node, and akapen is run by bun or compiled by it.
    expect(askInstructions(['bun', CLI, 'channel', 'instructions'])).toBe(INSTRUCTIONS);
  });

  it('refuses what a failing akapen printed before it failed', () => {
    withDir((dir) => {
      const failing = join(dir, 'failing');
      writeFileSync(failing, '#!/bin/sh\necho http://127.0.0.1:4300\nexit 1\n');
      chmodSync(failing, 0o755);
      expect(askInstructions([failing])).toBeNull();
    });
  });

  it('refuses an older akapen that starts a channel and prints nothing', () => {
    withDir((dir) => {
      // What a version before `channel instructions` does: a channel when it has a session.
      const old = join(dir, 'old');
      writeFileSync(old, '#!/bin/sh\n[ -n "$CLAUDE_CODE_SESSION_ID" ] && exit 0\nexit 2\n');
      chmodSync(old, 0o755);
      const prev = process.env['CLAUDE_CODE_SESSION_ID'];
      process.env['CLAUDE_CODE_SESSION_ID'] = 'test';
      try {
        expect(askInstructions([old, 'channel', 'instructions'])).toBeNull();
      } finally {
        if (prev === undefined) delete process.env['CLAUDE_CODE_SESSION_ID'];
        else process.env['CLAUDE_CODE_SESSION_ID'] = prev;
      }
    });
  });

  it('refuses empty output even with status 0', () => {
    withDir((dir) => {
      const empty = join(dir, 'empty');
      writeFileSync(empty, '#!/bin/sh\necho\n');
      chmodSync(empty, 0o755);
      expect(askInstructions([empty])).toBeNull();
    });
  });
});
