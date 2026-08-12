import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Comment, RoundComment, RoundMeta } from '@akapen/shared';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  statSync,
  unlinkSync,
  existsSync,
} from 'node:fs';

export type { Comment, RoundComment, RoundMeta };

export type Review = {
  version: 2;
  path: string;
  /** 0 means no round has been opened yet. */
  currentRound: number;
  rounds: RoundMeta[];
};

/**
 * Comments are never written into the markdown file. Like crit, they live in a
 * sidecar. The markdown is the deliverable, so the path by which review notes
 * could end up in a commit is removed by design.
 */
export function storeDir(filePath: string): string {
  const abs = resolve(filePath);
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 12);
  const root = process.env['AKAPEN_HOME'] ?? join(homedir(), '.akapen');
  return join(root, 'reviews', `${basename(abs).replace(/\.md$/, '')}-${hash}`);
}

export function roundDir(filePath: string, n: number): string {
  return join(storeDir(filePath), 'rounds', String(n).padStart(3, '0'));
}

function reviewFile(filePath: string): string {
  return join(storeDir(filePath), 'review.json');
}

function writeAtomic(target: string, data: string): void {
  // Give the temp file a unique name. With a fixed name two processes truncate the
  // same file, so what rename commits is garbage even though rename itself is atomic
  // (opening the same markdown twice shares one store).
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* Losing the temp file must not hide the original failure. */
    }
    throw e;
  }
}

function isRoundMeta(v: unknown): v is RoundMeta {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as RoundMeta;
  return (
    Number.isInteger(r.n) &&
    r.n > 0 &&
    typeof r.createdAt === 'string' &&
    (r.closedAt === null || typeof r.closedAt === 'string')
  );
}

/**
 * Rebuild round metadata from what is actually on disk (directories holding a
 * content.md). Timestamps come from content.md's mtime. The frozen documents
 * themselves are never lost, so trusting the directories beats trusting
 * review.json and resetting the round number to 0.
 */
function roundsOnDisk(filePath: string): RoundMeta[] {
  const dir = join(storeDir(filePath), 'rounds');
  if (!existsSync(dir)) return [];
  const ns = readdirSync(dir)
    .map((name) => Number.parseInt(name, 10))
    .filter((n) => Number.isInteger(n) && n > 0 && existsSync(join(roundDir(filePath, n), 'content.md')))
    .toSorted((a, b) => a - b);
  const createdAt = (n: number) => statSync(join(roundDir(filePath, n), 'content.md')).mtime.toISOString();
  return ns.map((n, i) => ({
    n,
    createdAt: createdAt(n),
    closedAt: i < ns.length - 1 ? createdAt(ns[i + 1]!) : null,
  }));
}

export function loadReview(filePath: string): Review {
  const f = reviewFile(filePath);
  if (existsSync(f)) {
    try {
      const parsed = JSON.parse(readFileSync(f, 'utf8')) as Partial<Review>;
      const rounds = Array.isArray(parsed.rounds) ? parsed.rounds.filter(isRoundMeta) : null;
      const currentRound = parsed.currentRound;
      if (rounds && Number.isInteger(currentRound) && currentRound! >= 0) {
        // Rounds can exist on disk without being listed in review.json (an old
        // review.json was restored, or a write died halfway). Reconciling against
        // the directories is what keeps cross-round reads from silently missing them.
        const disk = roundsOnDisk(filePath);
        const known = new Set(rounds.map((r) => r.n));
        const merged = [...rounds, ...disk.filter((r) => !known.has(r.n))].toSorted((a, b) => a.n - b.n);
        return {
          version: 2,
          path: resolve(filePath),
          currentRound: Math.max(currentRound!, merged.at(-1)?.n ?? 0),
          rounds: merged,
        };
      }
    } catch {
      /* Corrupt. Fall through to the recovery below. */
    }
  }
  // With review.json missing or corrupt, recover from the rounds on disk.
  // Resetting currentRound to 0 here would make openRound overwrite round 001,
  // destroying a frozen document and its comments.
  const rounds = roundsOnDisk(filePath);
  return { version: 2, path: resolve(filePath), currentRound: rounds.at(-1)?.n ?? 0, rounds };
}

export function saveReview(review: Review): void {
  mkdirSync(storeDir(review.path), { recursive: true });
  writeAtomic(reviewFile(review.path), JSON.stringify(review, null, 2));
}

/**
 * Freeze the current file contents and open the next round.
 *
 * Comments do not carry over. Not aligning positions across rounds is the whole
 * point of rounds; carrying them makes "which document is this about" vague again
 * and brings the re-anchoring problem back.
 */
export function openRound(filePath: string, source: string): Review {
  const review = loadReview(filePath);
  const now = new Date().toISOString();
  // Never step on an existing round, even when review.json is stale (restored from a backup).
  const n = Math.max(review.currentRound, roundsOnDisk(filePath).at(-1)?.n ?? 0) + 1;

  const dir = roundDir(filePath, n);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, 'content.md'), source);
  writeAtomic(join(dir, 'comments.json'), JSON.stringify([], null, 2));

  const prev = review.rounds.find((r) => r.n === review.currentRound);
  if (prev) prev.closedAt = now;
  review.rounds.push({ n, createdAt: now, closedAt: null });
  review.currentRound = n;

  saveReview(review);
  return review;
}

/** Open a round only when there is none, or its snapshot has gone missing. */
export function ensureRound(filePath: string, source: string): Review {
  const review = loadReview(filePath);
  if (review.currentRound > 0 && existsSync(join(roundDir(filePath, review.currentRound), 'content.md'))) {
    return review;
  }
  return openRound(filePath, source);
}

export function roundContent(filePath: string, n: number): string {
  return readFileSync(join(roundDir(filePath, n), 'content.md'), 'utf8');
}

export function loadComments(filePath: string, n: number): Comment[] {
  const f = join(roundDir(filePath, n), 'comments.json');
  if (!existsSync(f)) return [];
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Comment[]) : [];
  } catch {
    return [];
  }
}

/**
 * Every round's comments, newest round first.
 *
 * Rounds do not carry comments over, so the only way to answer "what was raised
 * before" is to read each round's comments.json. The history UI and the agent
 * handoff ask the same question, so they read from one place.
 */
export function loadAllComments(filePath: string): RoundComment[] {
  const review = loadReview(filePath);
  const out: RoundComment[] = [];
  for (const r of review.rounds.toSorted((a, b) => b.n - a.n)) {
    for (const c of loadComments(filePath, r.n)) out.push({ ...c, round: r.n });
  }
  return out;
}

/** Round numbers present on disk. Used to check the cross-round read misses nothing. */
export function roundNumbersOnDisk(filePath: string): number[] {
  return roundsOnDisk(filePath).map((r) => r.n);
}

/** Unresolved comments from earlier rounds: gone from the screen, not gone as feedback. */
export function carriedOver(filePath: string): RoundComment[] {
  const review = loadReview(filePath);
  return loadAllComments(filePath).filter((c) => c.round !== review.currentRound && !c.resolved);
}

/**
 * Comments handed to the agent: current round first, in line order within a round.
 *
 * Since nothing carries over, round N's unresolved comments do not appear on N+1's
 * screen. Disappearing from the screen is fine — history covers that — but not
 * reaching the agent would lose the feedback itself. Closing a round *means*
 * handing work over, so unresolved comments keep being emitted after it closes.
 */
export function pendingComments(filePath: string, includeResolved = false): RoundComment[] {
  return loadAllComments(filePath)
    .filter((c) => includeResolved || !c.resolved)
    .toSorted((a, b) => b.round - a.round || a.startLine - b.startLine);
}

/**
 * Update a comment's state by id, without naming a round.
 *
 * "Past rounds are read-only" is about the snapshot and the line anchors. Freezing
 * the status too would leave no way to close an unresolved comment, and
 * `akapen comments` would emit the same feedback forever.
 */
export function updateComment(
  filePath: string,
  id: string,
  patch: (c: Comment) => void,
): RoundComment | null {
  const review = loadReview(filePath);
  for (const r of review.rounds.toSorted((a, b) => b.n - a.n)) {
    const comments = loadComments(filePath, r.n);
    const target = comments.find((c) => c.id === id);
    if (!target) continue;
    patch(target);
    saveComments(filePath, r.n, comments);
    return { ...target, round: r.n };
  }
  return null;
}

export function saveComments(filePath: string, n: number, comments: Comment[]): void {
  const dir = roundDir(filePath, n);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, 'comments.json'), JSON.stringify(comments, null, 2));
}

/** `source` must be the round's snapshot. Passing the live file makes the anchor disagree with the document. */
export function makeComment(
  source: string,
  startLine: number,
  endLine: number,
  body: string,
  author: string,
): Comment {
  const lines = source.split('\n');
  return {
    id: `c_${createHash('sha1').update(`${startLine}:${endLine}:${body}:${Date.now()}`).digest('hex').slice(0, 6)}`,
    startLine,
    endLine,
    body,
    author,
    createdAt: new Date().toISOString(),
    resolved: false,
    anchor: lines.slice(startLine - 1, endLine).join('\n'),
  };
}
