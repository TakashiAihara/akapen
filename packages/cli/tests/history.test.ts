/**
 * `akapen history`: which comments it prints and in what order.
 *
 * The filters are where this goes wrong quietly. A filter that matches nothing prints
 * `[]`, which reads as "nothing like that was ever said", so each one is checked against
 * comments it has to keep and comments it has to drop.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ensureRound,
  saveComments,
  storeDir,
  type Comment,
  type ReviewComments,
  type RoundComment,
} from '@akapen/core/store';

import { UsageError } from '../src/args.ts';
import { historyJson, parseSince, readable } from '../src/history.ts';

function comment(id: string, over: Partial<Comment>): Comment {
  return {
    id,
    startLine: 3,
    endLine: 4,
    body: `body of ${id}`,
    author: 'alice',
    createdAt: '2026-08-10T00:00:00.000Z',
    resolved: false,
    anchor: 'the text',
    replies: [],
    ...over,
  };
}

const REVIEWS: ReviewComments[] = [
  {
    reviewId: 'plan-aaaaaaaaaaaa',
    path: '/docs/plan.md',
    currentRound: 2,
    comments: [
      { ...comment('c_new', { createdAt: '2026-08-20T00:00:00.000Z', body: 'Rename the FLAG' }), round: 2 },
      {
        ...comment('c_old', { createdAt: '2026-08-01T09:00:00.000Z', author: 'bob', resolved: true }),
        round: 1,
      },
    ],
  },
  {
    reviewId: 'spec-bbbbbbbbbbbb',
    path: null,
    currentRound: 1,
    comments: [
      {
        ...comment('c_mid', {
          createdAt: '2026-08-12T03:53:17.933Z',
          body: 'a flag nobody reads',
          replies: [
            {
              id: 'r_1',
              body: 'removed it',
              author: 'agent-1',
              authorKind: 'agent',
              sessionId: 's-1',
              createdAt: '2026-08-12T04:00:00.000Z',
            },
          ],
        }),
        round: 1,
      },
    ],
  },
];

const ids = (out: { id: string }[]) => out.map((c) => c.id);

describe('historyJson', () => {
  it('prints unresolved comments of every review, oldest first', () => {
    expect(ids(historyJson(REVIEWS, { all: false }))).toEqual(['c_mid', 'c_new']);
  });

  it('includes resolved ones with --all', () => {
    expect(ids(historyJson(REVIEWS, { all: true }))).toEqual(['c_old', 'c_mid', 'c_new']);
  });

  it('prints the comments shape with the review it came from and when it was made', () => {
    const [mid] = historyJson(REVIEWS, { all: false });
    expect(mid).toEqual({
      review_id: 'spec-bbbbbbbbbbbb',
      id: 'c_mid',
      path: null,
      round: 1,
      current_round: true,
      start_line: 3,
      end_line: 4,
      body: 'a flag nobody reads',
      anchor: 'the text',
      author: 'alice',
      resolved: false,
      last_author_kind: 'agent',
      replies: [
        {
          id: 'r_1',
          body: 'removed it',
          author: 'agent-1',
          author_kind: 'agent',
          session_id: 's-1',
          created_at: '2026-08-12T04:00:00.000Z',
        },
      ],
      created_at: '2026-08-12T03:53:17.933Z',
    });
  });

  it('marks a comment from an earlier round as not current', () => {
    const old = historyJson(REVIEWS, { all: true }).find((c) => c.id === 'c_old')!;
    expect(old.current_round).toBe(false);
    expect(old.path).toBe('/docs/plan.md');
    expect(old.review_id).toBe('plan-aaaaaaaaaaaa');
  });

  it('matches --grep against the body as plain text, in any case', () => {
    expect(ids(historyJson(REVIEWS, { all: true, grep: 'flag' }))).toEqual(['c_mid', 'c_new']);
    expect(ids(historyJson(REVIEWS, { all: true, grep: 'FLAG N' }))).toEqual(['c_mid']);
    // A pattern character is a character: `.` does not stand for "anything".
    expect(ids(historyJson(REVIEWS, { all: true, grep: 'a.flag' }))).toEqual([]);
    // Replies are not the comment's body.
    expect(ids(historyJson(REVIEWS, { all: true, grep: 'removed' }))).toEqual([]);
  });

  it('keeps only the named author with --author', () => {
    expect(ids(historyJson(REVIEWS, { all: true, author: 'bob' }))).toEqual(['c_old']);
    expect(ids(historyJson(REVIEWS, { all: true, author: 'Bob' }))).toEqual([]);
  });

  it('keeps comments made at or after --since', () => {
    const since = parseSince('2026-08-12T03:53:17.933Z');
    expect(ids(historyJson(REVIEWS, { all: true, since }))).toEqual(['c_mid', 'c_new']);
    expect(ids(historyJson(REVIEWS, { all: true, since: parseSince('2026-08-02') }))).toEqual([
      'c_mid',
      'c_new',
    ]);
  });

  it('breaks a tie on the time by review, then by id', () => {
    const at = '2026-09-01T00:00:00.000Z';
    const tied: ReviewComments[] = [
      {
        reviewId: 'b-review',
        path: null,
        currentRound: 1,
        comments: [{ ...comment('c_1', { createdAt: at }), round: 1 }],
      },
      {
        reviewId: 'a-review',
        path: null,
        currentRound: 1,
        comments: [
          { ...comment('c_9', { createdAt: at }), round: 1 },
          { ...comment('c_2', { createdAt: at }), round: 1 },
        ],
      },
    ];
    expect(historyJson(tied, { all: false }).map((c) => `${c.review_id}/${c.id}`)).toEqual([
      'a-review/c_2',
      'a-review/c_9',
      'b-review/c_1',
    ]);
  });

  it('combines the filters', () => {
    expect(
      ids(
        historyJson(REVIEWS, { all: true, grep: 'flag', author: 'alice', since: parseSince('2026-08-15') }),
      ),
    ).toEqual(['c_new']);
  });
});

describe('parseSince', () => {
  it('reads a date as midnight UTC', () => {
    expect(parseSince('2026-08-01')).toBe(Date.UTC(2026, 7, 1));
  });

  it('reads a timestamp in the offset it gives', () => {
    expect(parseSince('2026-08-01T09:00+09:00')).toBe(Date.UTC(2026, 7, 1));
    expect(parseSince('2026-08-01T00:00:00.000Z')).toBe(Date.UTC(2026, 7, 1));
  });

  it.each([
    ['what is not a date', 'last week'],
    ['a bare number Date.parse reads as a year', '1'],
    ['a time with no offset, which Date.parse reads as local time', '2026-08-01T09:00'],
    ['a date that does not exist', '2026-13-01'],
  ])('refuses %s rather than guessing', (_label, raw) => {
    expect(() => parseSince(raw)).toThrow(UsageError);
    expect(() => parseSince(raw)).toThrow(/--since must be a date/);
  });
});

describe('readable', () => {
  const good = { ...comment('c_good', {}), round: 1 };
  it.each([
    ['no id', { id: 1 }],
    ['no body', { body: undefined }],
    ['no author', { author: null }],
    ['no resolved state', { resolved: 'no' }],
    ['no creation time', { createdAt: undefined }],
    ['no creation time', { createdAt: 'whenever' }],
    // Date.parse reads the number 5 as the year 2005; a time that is not text is not one.
    ['no creation time', { createdAt: 5 }],
  ])('sets aside a comment with %s and says which', (reason, broken) => {
    const bad = { ...good, id: 'c_bad', ...broken } as unknown as RoundComment;
    const { reviews, skipped } = readable([
      { reviewId: 'r', path: null, currentRound: 1, comments: [bad, good] },
    ]);
    expect(reviews[0]!.comments.map((c) => c.id)).toEqual(['c_good']);
    expect(skipped).toEqual([{ review_id: 'r', id: typeof bad.id === 'string' ? 'c_bad' : null, reason }]);
  });
});

describe('akapen history, from a real process', () => {
  const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

  it('prints the store as JSON through each filter, and refuses what it cannot take', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-history-'));
    try {
      const home = join(sandbox, 'home');
      const file = join(sandbox, 'note.md');
      writeFileSync(file, '# Heading\n\nA paragraph.\n');
      const env = { ...process.env, AKAPEN_HOME: home };
      let store = '';
      const history = (...extra: string[]) => {
        const out = spawnSync('bun', ['run', CLI, 'history', ...extra], { env, encoding: 'utf8' });
        expect(out.status).toBe(0);
        return (JSON.parse(out.stdout) as { id: string }[]).map((c) => c.id).toSorted();
      };
      process.env['AKAPEN_HOME'] = home;
      try {
        ensureRound(file, '# Heading\n\nA paragraph.\n');
        saveComments(file, 1, [
          comment('c_cli', { body: 'seen from the command' }),
          comment('c_other', { body: 'left out by the filter' }),
          comment('c_done', { body: 'resolved', resolved: true, author: 'bob' }),
          comment('c_early', { body: 'before the cut', createdAt: '2026-07-01T00:00:00.000Z' }),
        ]);
        store = storeDir(file);
      } finally {
        delete process.env['AKAPEN_HOME'];
      }

      const ok = spawnSync('bun', ['run', CLI, 'history', '--grep', 'COMMAND'], { env, encoding: 'utf8' });
      expect(ok.status).toBe(0);
      const printed = JSON.parse(ok.stdout) as { id: string; path: string }[];
      expect(printed.map((c) => [c.id, c.path])).toEqual([['c_cli', file]]);

      // The same shape as `akapen comments`, which is what lets a reader of one handle the other.
      const one = spawnSync('bun', ['run', CLI, 'comments', file], { env, encoding: 'utf8' });
      expect(one.status).toBe(0);
      const fromComments = (JSON.parse(one.stdout) as Record<string, unknown>[]).find(
        (c) => c['id'] === 'c_cli',
      );
      expect(fromComments).toMatchObject({ id: 'c_cli', path: file, round: 1, current_round: true });
      const [fromHistory] = JSON.parse(ok.stdout) as Record<string, unknown>[];
      const { review_id: _r, created_at: _c, ...rest } = fromHistory!;
      expect(rest).toEqual(fromComments);

      expect(history()).toEqual(['c_cli', 'c_early', 'c_other']);
      expect(history('--all')).toEqual(['c_cli', 'c_done', 'c_early', 'c_other']);
      expect(history('--all', '--author', 'bob')).toEqual(['c_done']);
      expect(history('--since', '2026-08-01')).toEqual(['c_cli', 'c_other']);

      const extra = spawnSync('bun', ['run', CLI, 'history', file], { env, encoding: 'utf8' });
      expect(extra.status).toBe(1);
      expect(extra.stderr).toContain('history: unexpected');

      // One unreadable entry is named and left out; the rest still print.
      const f = join(store, 'rounds', '001', 'comments.json');
      writeFileSync(
        f,
        JSON.stringify([...(JSON.parse(readFileSync(f, 'utf8')) as unknown[]), { id: 'c_broken' }]),
      );
      const mixed = spawnSync('bun', ['run', CLI, 'history', '--grep', 'command'], { env, encoding: 'utf8' });
      expect(mixed.status).toBe(0);
      expect((JSON.parse(mixed.stdout) as { id: string }[]).map((c) => c.id)).toEqual(['c_cli']);
      expect(mixed.stderr).toContain('skipped c_broken in');
      expect(mixed.stderr).toContain(': no body');

      const bad = spawnSync('bun', ['run', CLI, 'history', '--since', 'yesterday'], {
        env,
        encoding: 'utf8',
      });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('--since must be a date');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
