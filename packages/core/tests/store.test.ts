/**
 * The round storage layer.
 *
 * When this breaks, a frozen document and its feedback disappear quietly. It happened:
 * while building the history view, loadAllComments trusted review.json and missed
 * rounds that were on disk.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  carriedOver,
  ensureRound,
  loadAllComments,
  loadComments,
  loadReview,
  makeComment,
  openRound,
  pendingComments,
  roundContent,
  roundNumbersOnDisk,
  saveComments,
  storeDir,
  updateComment,
  type Comment,
} from '../src/store.ts';

const SOURCE = [
  '---',
  'title: t',
  'status: active',
  '---',
  '',
  '# Heading',
  '',
  'A paragraph.',
  '',
  '- An item',
  '',
].join('\n');
const EDITED = `${SOURCE}\n## Added\n\nthe agent fixed it.\n`;

let sandbox: string;
let work: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'akapen-test-'));
  process.env['AKAPEN_HOME'] = join(sandbox, 'home');
  work = join(sandbox, 'note.md');
  writeFileSync(work, SOURCE);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env['AKAPEN_HOME'];
});

/** Seed round 001 with a few comments and return them. */
function seed(): Comment[] {
  ensureRound(work, SOURCE);
  const comments = [
    makeComment(SOURCE, 3, 3, 'about the status line', 't'),
    makeComment(SOURCE, 6, 6, 'about the heading', 't'),
    makeComment(SOURCE, 8, 8, 'about the paragraph', 't'),
  ];
  saveComments(work, 1, comments);
  return comments;
}

describe('freezing a round', () => {
  it('opens the first round with a snapshot equal to the source', () => {
    expect(ensureRound(work, SOURCE).currentRound).toBe(1);
    expect(roundContent(work, 1)).toBe(SOURCE);
  });

  it('anchors comments to the matching snapshot lines', () => {
    const comments = seed();
    const snap = roundContent(work, 1).split('\n');
    for (const c of comments) {
      expect(snap.slice(c.startLine - 1, c.endLine).join('\n')).toBe(c.anchor);
    }
  });

  it('leaves the current round alone when the live file changes', () => {
    const comments = seed();
    writeFileSync(work, EDITED);
    expect(roundContent(work, 1)).toBe(SOURCE);
    expect(loadComments(work, 1)).toEqual(comments);
  });

  it('advances the number and carries no comments when a round is cut', () => {
    const comments = seed();
    const r2 = openRound(work, EDITED);
    expect(r2.currentRound).toBe(2);
    expect(roundContent(work, 2)).toBe(EDITED);
    expect(loadComments(work, 2)).toEqual([]);
    expect(roundContent(work, 1)).toBe(SOURCE);
    expect(loadComments(work, 1)).toEqual(comments);
    expect(r2.rounds.find((r) => r.n === 1)?.closedAt).not.toBeNull();
  });

  it('reproduces where feedback pointed from round + content.md + line', () => {
    const comments = seed();
    openRound(work, EDITED);
    const snap = roundContent(work, 1).split('\n');
    for (const c of comments) {
      expect(snap.slice(c.startLine - 1, c.endLine).join('\n')).toBe(c.anchor);
    }
  });
});

describe('surviving a lost review.json', () => {
  // Losing a frozen document is the worst failure this design has. review.json is only metadata.
  const broken: [string, (dir: string) => void][] = [
    ['is corrupt', (dir) => writeFileSync(join(dir, 'review.json'), '{ broken')],
    ['is missing', (dir) => rmSync(join(dir, 'review.json'))],
    [
      'has a non-array rounds',
      (dir) => writeFileSync(join(dir, 'review.json'), '{"currentRound":2,"rounds":{}}'),
    ],
  ];

  for (const [label, corrupt] of broken) {
    it(`recovers the round number and overwrites nothing when review.json ${label}`, () => {
      const comments = seed();
      openRound(work, EDITED);
      corrupt(storeDir(work));

      expect(loadReview(work).currentRound).toBe(2);
      ensureRound(work, EDITED);
      expect(roundContent(work, 1)).toBe(SOURCE);
      expect(loadComments(work, 1)).toEqual(comments);
    });
  }

  it('does not step on existing rounds when review.json points at an old number', () => {
    seed();
    openRound(work, EDITED);
    writeFileSync(
      join(storeDir(work), 'review.json'),
      JSON.stringify({ version: 2, currentRound: 1, rounds: [] }),
    );

    const r3 = openRound(work, EDITED);
    expect(r3.currentRound).toBe(3);
    expect(roundContent(work, 1)).toBe(SOURCE);
    expect(roundContent(work, 3)).toBe(EDITED);
    expect(loadComments(work, 3)).toEqual([]);
  });

  it('includes rounds missing from review.json in the cross-round read', () => {
    seed();
    openRound(work, EDITED);
    writeFileSync(
      join(storeDir(work), 'review.json'),
      JSON.stringify({ version: 2, currentRound: 1, rounds: [] }),
    );

    const known = new Set(loadReview(work).rounds.map((r) => r.n));
    expect(roundNumbersOnDisk(work).every((n) => known.has(n))).toBe(true);
    expect(loadAllComments(work).length).toBe(3);
  });

  it('opens a round only when there is none', () => {
    mkdirSync(storeDir(work), { recursive: true });
    expect(loadReview(work).currentRound).toBe(0);
    expect(ensureRound(work, SOURCE).currentRound).toBe(1);
    expect(ensureRound(work, SOURCE).currentRound).toBe(1);
  });
});

describe('reading across rounds', () => {
  it('returns every round newest first, tagged with its round', () => {
    seed();
    openRound(work, EDITED);
    saveComments(work, 2, [makeComment(EDITED, 6, 6, 'raised in R002', 't')]);

    const all = loadAllComments(work);
    expect(all.length).toBe(4);
    expect(all.every((c, i) => i === 0 || all[i - 1]!.round >= c.round)).toBe(true);
    expect(new Set(all.map((c) => c.round))).toEqual(new Set([1, 2]));
  });

  it('updates by id without naming a round', () => {
    const comments = seed();
    openRound(work, EDITED);

    const updated = updateComment(work, comments[0]!.id, (c) => {
      c.resolved = true;
    });
    expect(updated?.round).toBe(1);
    expect(loadComments(work, 1).find((c) => c.id === comments[0]!.id)?.resolved).toBe(true);
    expect(updateComment(work, 'c_nope', () => {})).toBeNull();
  });

  it('carries over only unresolved comments from earlier rounds', () => {
    const comments = seed();
    updateComment(work, comments[0]!.id, (c) => {
      c.resolved = true;
    });
    openRound(work, EDITED);
    saveComments(work, 2, [makeComment(EDITED, 6, 6, 'raised in R002', 't')]);

    const carried = carriedOver(work);
    expect(carried.map((c) => c.body)).toEqual(['about the heading', 'about the paragraph']);
    expect(carried.every((c) => c.round === 1)).toBe(true);
  });
});

describe('handing work to the agent', () => {
  it('keeps emitting unresolved comments after a round closes', () => {
    seed();
    expect(pendingComments(work).length).toBe(3);
    openRound(work, EDITED);
    // This going to zero was the hole rounds left open
    expect(pendingComments(work).length).toBe(3);
  });

  it('puts the current round first, then orders by line', () => {
    seed();
    openRound(work, EDITED);
    const fresh = makeComment(EDITED, 6, 6, 'raised in R002', 't');
    saveComments(work, 2, [fresh]);

    const pending = pendingComments(work);
    expect(pending[0]!.id).toBe(fresh.id);
    expect(pending.map((c) => `R${c.round}:L${c.startLine}`)).toEqual(['R2:L6', 'R1:L3', 'R1:L6', 'R1:L8']);
  });

  it('hides resolved comments unless asked for them', () => {
    const comments = seed();
    updateComment(work, comments[0]!.id, (c) => {
      c.resolved = true;
    });
    expect(pendingComments(work).length).toBe(2);
    expect(pendingComments(work, true).length).toBe(3);
  });

  it('carries the source text as it was', () => {
    seed();
    expect(pendingComments(work).every((c) => c.anchor.length > 0)).toBe(true);
  });
});
