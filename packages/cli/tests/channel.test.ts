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
import { describe, expect, it } from 'vitest';
import { collect, filesForSession, idsOf, newEvents } from '../src/channel.ts';
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
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
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
