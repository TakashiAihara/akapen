/**
 * The round storage layer.
 *
 * When this breaks, a frozen document and its feedback disappear quietly. It happened:
 * while building the history view, loadAllComments trusted review.json and missed
 * rounds that were on disk.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addReply,
  carriedOver,
  ensureRound,
  loadAllComments,
  loadComments,
  loadReview,
  makeComment,
  openRound,
  pendingComments,
  roundContent,
  roundDir,
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

describe('replies', () => {
  it('adds one to a comment in the current round', () => {
    const [first] = seed();
    const added = addReply(work, first!.id, 'reworded', 'someone');
    expect(added?.reply.body).toBe('reworded');
    expect(added?.reply.authorKind).toBe('human');
    expect(added?.comment.round).toBe(1);
    // Read back from disk, not from the return value: the point is that it persisted.
    expect(loadComments(work, 1)[0]?.replies).toHaveLength(1);
  });

  it('adds one to a comment carried from a closed round', () => {
    // The main thing replies are for: answering feedback on work already handed over.
    const [first] = seed();
    openRound(work, EDITED);
    const added = addReply(work, first!.id, 'could not fix, because X', 'agent-1', 'agent');
    expect(added?.comment.round).toBe(1);
    expect(added?.reply.authorKind).toBe('agent');
    expect(loadComments(work, 1)[0]?.replies?.[0]?.body).toBe('could not fix, because X');
    // The reply went to the parent's round, not the current one.
    expect(loadComments(work, 2)).toEqual([]);
  });

  it('stores the session an agent reply names, and none for a person', () => {
    const [first] = seed();
    addReply(work, first!.id, 'from a session', 'root', 'agent', 'sess-1');
    addReply(work, first!.id, 'from a person', 'root');
    const replies = loadComments(work, 1)[0]?.replies ?? [];
    expect(replies[0]?.authorKind).toBe('agent');
    expect(replies[0]?.sessionId).toBe('sess-1');
    expect(replies[1]?.authorKind).toBe('human');
    expect(replies[1]?.sessionId).toBeUndefined();
  });

  it('keeps them in the order they were written', () => {
    const [first] = seed();
    addReply(work, first!.id, 'one', 't');
    addReply(work, first!.id, 'two', 't');
    expect(loadComments(work, 1)[0]?.replies?.map((r) => r.body)).toEqual(['one', 'two']);
  });

  it('answers null for a comment that does not exist', () => {
    seed();
    expect(addReply(work, 'c_nope', 'x', 't')).toBeNull();
  });

  it('reads a comment written before replies existed as having none', () => {
    // Files on disk predate this feature and have no `replies` key. A plain push would
    // throw on undefined; the reply has to land on an empty list instead.
    ensureRound(work, SOURCE);
    const legacy = makeComment(SOURCE, 6, 6, 'about the heading', 't');
    delete (legacy as { replies?: unknown }).replies;
    saveComments(work, 1, [legacy]);

    const added = addReply(work, legacy.id, 'first reply', 't');
    expect(added?.reply.body).toBe('first reply');
    expect(loadComments(work, 1)[0]?.replies).toHaveLength(1);
  });

  it('travels with its parent into carriedOver', () => {
    const [first] = seed();
    addReply(work, first!.id, 'why it is still open', 't');
    openRound(work, EDITED);
    const carried = carriedOver(work).find((c) => c.id === first!.id);
    expect(carried?.replies?.[0]?.body).toBe('why it is still open');
  });
});

describe('validating stored JSON', () => {
  const commentsFile = () => join(roundDir(work, 1), 'comments.json');
  const raw = (entries: unknown[]) => writeFileSync(commentsFile(), JSON.stringify(entries));
  const legacyComment = {
    id: 'c_old111',
    startLine: 6,
    endLine: 7,
    body: 'written before replies existed',
    author: 'someone',
    createdAt: '2026-01-02T03:04:05.000Z',
    resolved: false,
    anchor: '## Heading\nline',
  };

  it('loads a comment from before replies existed with body and anchor intact', () => {
    ensureRound(work, SOURCE);
    raw([legacyComment]);
    const [c] = loadComments(work, 1);
    expect(c?.body).toBe('written before replies existed');
    expect(c?.anchor).toBe('## Heading\nline');
    expect(c?.replies).toEqual([]);
  });

  it('loads a reply written before sessionId existed', () => {
    ensureRound(work, SOURCE);
    const reply = {
      id: 'r_aa',
      body: 'old reply',
      author: 'a',
      authorKind: 'agent',
      createdAt: '2026-01-02T00:00:00.000Z',
    };
    raw([{ ...legacyComment, replies: [reply] }]);
    expect(loadComments(work, 1)[0]?.replies?.[0]?.body).toBe('old reply');
  });

  it('skips only the invalid entry and says so on stderr with the file and count', () => {
    ensureRound(work, SOURCE);
    raw([legacyComment, { id: 'c_bad', startLine: 'x' }, { ...legacyComment, id: 'c_old222' }]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(loadComments(work, 1).map((c) => c.id)).toEqual(['c_old111', 'c_old222']);
      const msg = String(spy.mock.calls[0]?.[0]);
      expect(msg).toContain(commentsFile());
      expect(msg).toContain('skipped 1 comment(s)');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a rejected entry in the file across a write', () => {
    ensureRound(work, SOURCE);
    const bad = { id: 'c_bad', startLine: 'x', body: 'hand-edited, must not vanish' };
    raw([legacyComment, bad]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(updateComment(work, 'c_old111', (c) => (c.resolved = true))?.resolved).toBe(true);
      addReply(work, 'c_old111', 'hello', 't');
    } finally {
      spy.mockRestore();
    }
    const onDisk = JSON.parse(readFileSync(commentsFile(), 'utf8')) as { id: string }[];
    expect(onDisk.filter((e) => e.id === 'c_bad')).toEqual([bad]);
    expect(onDisk).toHaveLength(2);
  });

  it('keeps the bytes of a comments.json that is not an array when it is written over', () => {
    ensureRound(work, SOURCE);
    writeFileSync(commentsFile(), '{"not":"an array"');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(loadComments(work, 1)).toEqual([]);
      saveComments(work, 1, [makeComment(SOURCE, 3, 3, 'new', 't')]);
    } finally {
      spy.mockRestore();
    }
    const backups = readdirSync(roundDir(work, 1)).filter((n) => n.startsWith('comments.json.unreadable-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(roundDir(work, 1), backups[0]!), 'utf8')).toBe('{"not":"an array"');
  });

  it('recovers from a review.json whose fields have the wrong types', () => {
    openRound(work, SOURCE);
    writeFileSync(join(storeDir(work), 'review.json'), JSON.stringify({ currentRound: '1', rounds: 'x' }));
    const r = loadReview(work);
    expect(r.currentRound).toBe(1);
    expect(r.rounds.map((x) => x.n)).toEqual([1]);
  });

  it('drops a malformed round entry from review.json and rebuilds it from disk', () => {
    openRound(work, SOURCE);
    writeFileSync(
      join(storeDir(work), 'review.json'),
      JSON.stringify({ currentRound: 1, rounds: [{ n: 1, createdAt: 5, closedAt: null }] }),
    );
    const r = loadReview(work);
    expect(r.rounds).toHaveLength(1);
    expect(typeof r.rounds[0]?.createdAt).toBe('string');
  });
});
