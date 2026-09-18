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
import { filesForSession, idsOf, newEvents } from '../src/channel.ts';
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
  });

  it('does not report the same unresolved comment twice', () => {
    const first = newEvents('/n/a.md', [comment('c1')], undefined);
    const second = newEvents('/n/a.md', [comment('c2'), comment('c1')], first.known);
    const third = newEvents('/n/a.md', [comment('c2'), comment('c1')], second.known);
    expect(third.events).toEqual([]);
  });

  it('carries the anchor, because line numbers belong to the round', () => {
    const first = newEvents('/n/a.md', [], undefined);
    const { events } = newEvents('/n/a.md', [comment('c1', { anchor: '### Q-04 something' })], first.known);
    expect(events[0]?.content).toContain('### Q-04 something');
  });

  it('keys meta by identifiers, which is all Claude Code keeps', () => {
    const first = newEvents('/n/a.md', [], undefined);
    const { events } = newEvents('/n/a.md', [comment('c1')], first.known);
    for (const key of Object.keys(events[0]?.meta ?? {})) expect(key).toMatch(/^[A-Za-z0-9_]+$/);
  });
});
