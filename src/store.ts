import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

export type Comment = {
  id: string;
  startLine: number;
  endLine: number;
  body: string;
  author: string;
  createdAt: string;
  resolved: boolean;
  /** 作成時点のアンカー範囲の原文。再アンカーの鍵。 */
  anchor: string;
  before: string;
  after: string;
  /** 原文が見つからなくなった状態。位置は最後に判っていた行のまま。 */
  drifted: boolean;
};

export type Store = {
  version: 1;
  path: string;
  comments: Comment[];
};

/**
 * コメントは md 実ファイルには一切書かない。crit と同じくサイドカーに隔離する。
 * md 本体が成果物なので、レビュー用の注記が commit に混入する経路を設計から消す。
 */
export function storeDir(filePath: string): string {
  const abs = resolve(filePath);
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 12);
  return join(homedir(), '.akapen', 'reviews', `${basename(abs).replace(/\.md$/, '')}-${hash}`);
}

function storeFile(filePath: string): string {
  return join(storeDir(filePath), 'comments.json');
}

export function load(filePath: string): Store {
  const f = storeFile(filePath);
  if (!existsSync(f)) return { version: 1, path: resolve(filePath), comments: [] };
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as Store;
    return { version: 1, path: resolve(filePath), comments: parsed.comments ?? [] };
  } catch {
    return { version: 1, path: resolve(filePath), comments: [] };
  }
}

export function save(store: Store): void {
  const dir = storeDir(store.path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'comments.json.tmp');
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  writeFileSync(storeFile(store.path), readFileSync(tmp));
}

function rangeText(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join('\n');
}

function neighbours(lines: string[], start: number, end: number): { before: string; after: string } {
  let before = '';
  for (let i = start - 2; i >= 0; i--) {
    if (lines[i]!.trim()) {
      before = lines[i]!;
      break;
    }
  }
  let after = '';
  for (let i = end; i < lines.length; i++) {
    if (lines[i]!.trim()) {
      after = lines[i]!;
      break;
    }
  }
  return { before, after };
}

export function makeComment(
  source: string,
  startLine: number,
  endLine: number,
  body: string,
  author: string,
): Comment {
  const lines = source.split('\n');
  const { before, after } = neighbours(lines, startLine, endLine);
  return {
    id: `c_${createHash('sha1').update(`${startLine}:${endLine}:${body}:${Date.now()}`).digest('hex').slice(0, 6)}`,
    startLine,
    endLine,
    body,
    author,
    createdAt: new Date().toISOString(),
    resolved: false,
    anchor: rangeText(lines, startLine, endLine),
    before,
    after,
    drifted: false,
  };
}

/**
 * ファイルが書き換わった後にコメントを貼り直す。
 * 行番号は最初に捨てて原文で探す。行番号を信じると、エージェントが上に段落を足しただけで
 * 全コメントが無関係な位置を指す (= 誤った指摘がそのままエージェントに渡る) 事故になる。
 */
export function reanchor(comments: Comment[], source: string): Comment[] {
  const lines = source.split('\n');
  return comments.map((c) => {
    const span = c.endLine - c.startLine + 1;

    // 1. 同じ位置に同じ原文があるならそのまま
    if (rangeText(lines, c.startLine, c.endLine) === c.anchor) {
      return { ...c, drifted: false };
    }

    // 2. 原文をファイル全体から探す
    const hits: number[] = [];
    for (let start = 1; start + span - 1 <= lines.length; start++) {
      if (rangeText(lines, start, start + span - 1) === c.anchor) hits.push(start);
    }

    if (hits.length === 1) {
      const start = hits[0]!;
      const end = start + span - 1;
      return { ...c, startLine: start, endLine: end, ...neighbours(lines, start, end), drifted: false };
    }

    if (hits.length > 1) {
      // 3. 同じ原文が複数あるときは前後の行で絞り、それでも決まらなければ元の位置に近い方
      const scored = hits.map((start) => {
        const end = start + span - 1;
        const n = neighbours(lines, start, end);
        const score = (n.before === c.before ? 2 : 0) + (n.after === c.after ? 2 : 0);
        return { start, end, n, score, distance: Math.abs(start - c.startLine) };
      });
      scored.sort((a, b) => b.score - a.score || a.distance - b.distance);
      const best = scored[0]!;
      return { ...c, startLine: best.start, endLine: best.end, ...best.n, drifted: false };
    }

    // 4. 見つからない。位置を推測せず drifted として人に判断させる
    return { ...c, drifted: true };
  });
}
