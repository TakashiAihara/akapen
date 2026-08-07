import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export type Comment = {
  id: string;
  /** 紐づくラウンドのスナップショット内での行番号。live のファイルに対しては意味を持たない。 */
  startLine: number;
  endLine: number;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  /**
   * スナップショットから切り出した原文。ラウンドをまたいで位置を伝えるのはこちらの役目。
   * エージェントは行番号ではなく原文で現在のファイルを照合するので、他の修正で行がズレても当たる。
   */
  anchor: string;
};

export type RoundMeta = {
  n: number;
  createdAt: string;
  /** 次のラウンドを開いた時刻。現ラウンドは null。 */
  closedAt: string | null;
};

export type Review = {
  version: 2;
  path: string;
  /** 0 はラウンドがまだ 1 つも無い状態。 */
  currentRound: number;
  rounds: RoundMeta[];
};

/**
 * コメントは md 実ファイルには一切書かない。crit と同じくサイドカーに隔離する。
 * md 本体が成果物なので、レビュー用の注記が commit に混入する経路を設計から消す。
 */
export function storeDir(filePath: string): string {
  const abs = resolve(filePath);
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 12);
  const root = process.env.AKAPEN_HOME ?? join(homedir(), '.akapen');
  return join(root, 'reviews', `${basename(abs).replace(/\.md$/, '')}-${hash}`);
}

export function roundDir(filePath: string, n: number): string {
  return join(storeDir(filePath), 'rounds', String(n).padStart(3, '0'));
}

function reviewFile(filePath: string): string {
  return join(storeDir(filePath), 'review.json');
}

function writeAtomic(target: string, data: string): void {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

export function loadReview(filePath: string): Review {
  const empty: Review = { version: 2, path: resolve(filePath), currentRound: 0, rounds: [] };
  const f = reviewFile(filePath);
  if (!existsSync(f)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as Partial<Review>;
    return {
      version: 2,
      path: resolve(filePath),
      currentRound: parsed.currentRound ?? 0,
      rounds: parsed.rounds ?? [],
    };
  } catch {
    return empty;
  }
}

export function saveReview(review: Review): void {
  mkdirSync(storeDir(review.path), { recursive: true });
  writeAtomic(reviewFile(review.path), JSON.stringify(review, null, 2));
}

/**
 * 現在のファイル内容を凍結して次のラウンドを開く。
 * コメントは持ち越さない。ラウンドをまたいだ位置合わせをしないのがラウンド制の要点で、
 * 持ち越すと結局「どの本文に対する指摘か」が曖昧になって再アンカーの問題が戻る。
 */
export function openRound(filePath: string, source: string): Review {
  const review = loadReview(filePath);
  const now = new Date().toISOString();
  const n = review.currentRound + 1;

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

/** ラウンドがまだ無い / スナップショットが失われている場合だけ新しく開く。 */
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

export function saveComments(filePath: string, n: number, comments: Comment[]): void {
  const dir = roundDir(filePath, n);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, 'comments.json'), JSON.stringify(comments, null, 2));
}

/** source はラウンドのスナップショット。live のファイルを渡すと anchor が本文とズレる。 */
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
