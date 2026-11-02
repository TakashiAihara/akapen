/**
 * What the channel pushes into a session.
 *
 * Three ways this fails quietly, and all three look identical from the session's side —
 * nothing arrives, or something arrives that should not have. Pushing a sibling
 * session's comments puts a document the reader never opened in front of them. Pushing
 * the backlog at startup buries the one comment that is new under everything already
 * handed over by `akapen comments`. Counting instead of naming re-fires on the same
 * unresolved comment every pass, forever.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  type Loaded,
} from '../src/channel.ts';
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

const reply = (id: string, createdAt = '2026-09-18T00:00:00.000Z') => ({
  id,
  body: `reply ${id}`,
  author: 'root',
  authorKind: 'human' as const,
  createdAt,
});

/** When the fixtures' akapen started: after everything `comment` and `reply` write by default. */
const STARTED = '2026-09-18T00:00:05.000Z';
const at = (iso: string): number => Date.parse(iso);

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

describe('newEvents on first sight, seeded from when the akapen started (#185)', () => {
  const since = at(STARTED);

  it('pushes what was written after the start and seeds what was written before it', () => {
    const before = comment('old', { createdAt: '2026-09-18T00:00:04.999Z' });
    const after = comment('new', { createdAt: '2026-09-18T00:00:06.000Z' });
    const { events, known } = newEvents('/n/a.md', [before, after], undefined, undefined, since);
    expect(events.map((e) => e.meta['comment_id'])).toEqual(['new']);
    // Left out of the seed, so it becomes known only once it has been delivered.
    expect([...known]).toEqual(['old']);
  });

  it('counts a comment written in the same millisecond the akapen started as new', () => {
    const { events } = newEvents(
      '/n/a.md',
      [comment('c1', { createdAt: STARTED })],
      undefined,
      undefined,
      since,
    );
    expect(events.map((e) => e.meta['comment_id'])).toEqual(['c1']);
  });

  it('pushes a reply written after the start on a comment written before it', () => {
    const c = comment('c1', { replies: [reply('r0'), reply('r1', '2026-09-18T00:00:07.000Z')] });
    const { events, known } = newEvents('/n/a.md', [c], undefined, undefined, since);
    expect(events.map((e) => e.meta['reply_id'])).toEqual(['r1']);
    expect([...known]).toEqual(['c1', 'c1/r0']);
  });

  it("does not push this session's own reply on first sight either", () => {
    const mine = { ...reply('mine', '2026-09-18T00:00:07.000Z'), sessionId: 'S1' };
    const { events } = newEvents('/n/a.md', [comment('c1', { replies: [mine] })], undefined, 'S1', since);
    expect(events).toEqual([]);
  });

  it('takes a comment whose time does not parse as history', () => {
    const { events, known } = newEvents(
      '/n/a.md',
      [comment('c1', { createdAt: 'soon' })],
      undefined,
      undefined,
      since,
    );
    expect(events).toEqual([]);
    expect([...known]).toEqual(['c1']);
  });
});

describe('the order a batch is pushed in (#185)', () => {
  it('is the order the comments were written, not line order', () => {
    const first = newEvents('/n/a.md', [], undefined);
    const comments = [
      comment('top', { startLine: 1, endLine: 1, createdAt: '2026-09-18T00:02:00.000Z' }),
      comment('middle', { startLine: 5, endLine: 5, createdAt: '2026-09-18T00:00:00.000Z' }),
      comment('bottom', { startLine: 9, endLine: 9, createdAt: '2026-09-18T00:01:00.000Z' }),
    ];
    const { events } = newEvents('/n/a.md', comments, first.known);
    expect(events.map((e) => e.meta['comment_id'])).toEqual(['middle', 'bottom', 'top']);
  });

  it('puts a reply between the comments written either side of it', () => {
    const first = newEvents('/n/a.md', [], undefined);
    const comments = [
      comment('c1', {
        createdAt: '2026-09-18T00:00:00.000Z',
        replies: [reply('r1', '2026-09-18T00:03:00.000Z')],
      }),
      comment('c2', { createdAt: '2026-09-18T00:05:00.000Z' }),
      comment('c3', { createdAt: '2026-09-18T00:01:00.000Z' }),
    ];
    const { events } = newEvents('/n/a.md', comments, first.known);
    expect(events.map((e) => e.meta['reply_id'] ?? e.meta['comment_id'])).toEqual(['c1', 'c3', 'r1', 'c2']);
  });

  it('keeps line order between comments written at the same time', () => {
    const first = newEvents('/n/a.md', [], undefined);
    const comments = [comment('b'), comment('a'), comment('c')];
    const { events } = newEvents('/n/a.md', comments, first.known);
    expect(events.map((e) => e.meta['comment_id'])).toEqual(['b', 'a', 'c']);
  });

  it('puts a comment whose time does not parse last', () => {
    const first = newEvents('/n/a.md', [], undefined);
    const comments = [
      comment('late', { createdAt: '2026-09-18T00:02:00.000Z' }),
      comment('broken', { createdAt: 'soon' }),
      comment('early', { createdAt: '2026-09-18T00:01:00.000Z' }),
    ];
    const { events } = newEvents('/n/a.md', comments, first.known);
    expect(events.map((e) => e.meta['comment_id'])).toEqual(['early', 'late', 'broken']);
  });
});

/** A store on no disk: what each pass sees is whatever the case hands it. */
const store = (files: string[], comments: Record<string, RoundComment[] | Error>, startedAt = STARTED) => ({
  instances: () =>
    files.map((file) => ({ file, host: '0.0.0.0', port: 4314, startedAt, origin: { id: 'S1' } })),
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

  it('pushes on first sight what was written after the akapen started, until it is delivered', () => {
    const seen = new Map<string, Set<string>>();
    const files = { '/n/a.md': [comment('old'), comment('new', { createdAt: '2026-09-18T00:00:06.000Z' })] };
    const first = collect('S1', seen, store(['/n/a.md'], files));
    expect(first.map((e) => e.meta['comment_id'])).toEqual(['new']);
    // Not delivered yet, so the next pass sends it again.
    expect(collect('S1', seen, store(['/n/a.md'], files)).map((e) => e.meta['comment_id'])).toEqual(['new']);
    for (const e of first) markSent(seen, e);
    expect(collect('S1', seen, store(['/n/a.md'], files))).toEqual([]);
  });

  it('seeds from the earliest of its instances on a document', () => {
    const records = [
      {
        file: '/n/a.md',
        host: '127.0.0.1',
        port: 4314,
        startedAt: '2026-09-18T00:00:10.000Z',
        origin: { id: 'S1' },
      },
      {
        file: '/n/a.md',
        host: '127.0.0.1',
        port: 4315,
        startedAt: '2026-09-18T00:00:02.000Z',
        origin: { id: 'S1' },
      },
      {
        file: '/n/a.md',
        host: '127.0.0.1',
        port: 4316,
        startedAt: '2026-09-18T00:00:20.000Z',
        origin: { id: 'S1' },
      },
    ];
    const written = comment('c1', { createdAt: '2026-09-18T00:00:05.000Z' });
    const events = collect('S1', new Map(), { instances: () => records, comments: () => [written] });
    expect(events.map((e) => e.meta['comment_id'])).toEqual(['c1']);
  });

  it("does not seed from a sibling session's instance on the same document", () => {
    const records = [
      {
        file: '/n/a.md',
        host: '127.0.0.1',
        port: 4314,
        startedAt: '2026-09-18T00:00:01.000Z',
        origin: { id: 'S2' },
      },
      {
        file: '/n/a.md',
        host: '127.0.0.1',
        port: 4315,
        startedAt: '2026-09-18T00:00:10.000Z',
        origin: { id: 'S1' },
      },
    ];
    const written = comment('c1', { createdAt: '2026-09-18T00:00:05.000Z' });
    expect(collect('S1', new Map(), { instances: () => records, comments: () => [written] })).toEqual([]);
  });

  it('seeds from the instance whose start time parses when another one does not', () => {
    const records = [
      { file: '/n/a.md', host: '127.0.0.1', port: 4314, startedAt: 'not a time', origin: { id: 'S1' } },
      {
        file: '/n/a.md',
        host: '127.0.0.1',
        port: 4315,
        startedAt: '2026-09-18T00:00:02.000Z',
        origin: { id: 'S1' },
      },
    ];
    const written = comment('c1', { createdAt: '2026-09-18T00:00:05.000Z' });
    const events = collect('S1', new Map(), { instances: () => records, comments: () => [written] });
    expect(events.map((e) => e.meta['comment_id'])).toEqual(['c1']);
  });

  it('seeds everything when the start time does not parse', () => {
    const files = { '/n/a.md': [comment('c1', { createdAt: '2026-09-18T00:00:06.000Z' })] };
    expect(collect('S1', new Map(), store(['/n/a.md'], files, 'not a time'))).toEqual([]);
  });

  it('pushes the events of several documents in the order they were written', () => {
    const seen = new Map<string, Set<string>>();
    collect('S1', seen, store(['/n/a.md', '/n/b.md'], {}));
    const events = collect(
      'S1',
      seen,
      store(['/n/a.md', '/n/b.md'], {
        '/n/a.md': [
          comment('a1', { createdAt: '2026-09-18T00:01:00.000Z' }),
          comment('a2', { createdAt: '2026-09-18T00:04:00.000Z' }),
        ],
        '/n/b.md': [
          comment('b1', { createdAt: '2026-09-18T00:02:00.000Z' }),
          comment('b2', { createdAt: '2026-09-18T00:03:00.000Z' }),
        ],
      }),
    );
    expect(events.map((e) => e.meta['comment_id'])).toEqual(['a1', 'b1', 'b2', 'a2']);
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
    const { spawn } = await import('node:child_process');

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
});

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

describe('the instructions handed to the session', () => {
  it("carry #12's rule for a comment whose anchored text has gone: say so, do not guess", () => {
    expect(INSTRUCTIONS).toContain(
      'If that text is no longer in the file, do not guess where the comment belongs or what it would say about the new text: reply on the thread that the passage has already changed.',
    );
  });
});
