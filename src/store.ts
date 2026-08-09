import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
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
  // 一時ファイル名を一意にする。固定名だと 2 プロセスが同じ tmp を truncate し合い、
  // renameSync が atomic でも確定する内容が壊れる (同じ md を 2 回開くと store を共有するため)。
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 消せなくても元の失敗を潰さない */
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
 * ラウンドの実体 (content.md があるディレクトリ) からメタ情報を組み直す。
 * 時刻は content.md の mtime から取る。凍結した本文そのものは失われないので、
 * review.json を正としてラウンド番号を 0 に戻すより、実体を信じる方が安全。
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
        // review.json に載っていないラウンドがディスクにあることがある (古い review.json を
        // 戻した / 途中で落ちた)。実体を正として突き合わせないと、横断読みが静かに取りこぼす。
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
      /* 壊れている。下の復元に落とす */
    }
  }
  // review.json が無い / 壊れている場合はラウンドの実体から復元する。
  // ここで currentRound を 0 に戻すと openRound が 001 を上書きし、凍結済みの本文とコメントが消える。
  const rounds = roundsOnDisk(filePath);
  return { version: 2, path: resolve(filePath), currentRound: rounds.at(-1)?.n ?? 0, rounds };
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
  // review.json が古い状態のまま (バックアップから戻した等) でも既存ラウンドを踏まない
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

/** どのラウンドのコメントかを付けて返す。ラウンドをまたいで扱う経路は必ずこれを通す。 */
export type RoundComment = Comment & { round: number };

/**
 * 全ラウンドのコメントを新しいラウンドから順に返す。
 *
 * ラウンド制ではコメントを持ち越さないので、「過去に何を指摘したか」を知る手段は
 * 各ラウンドの comments.json を横断して読むことしかない。UI の履歴 (#4) も
 * エージェントへの受け渡し (#5) も同じ問いなので、読む場所を 1 つにしておく。
 */
export function loadAllComments(filePath: string): RoundComment[] {
  const review = loadReview(filePath);
  const out: RoundComment[] = [];
  for (const r of review.rounds.toSorted((a, b) => b.n - a.n)) {
    for (const c of loadComments(filePath, r.n)) out.push({ ...c, round: r.n });
  }
  return out;
}

/** 横断読みが取りこぼしていないかの自己点検用。ディスク上のラウンド番号を返す。 */
export function roundNumbersOnDisk(filePath: string): number[] {
  return roundsOnDisk(filePath).map((r) => r.n);
}

/** 現ラウンドより前の未解決コメント。画面から消えても指摘は消えていない、を表す。 */
export function carriedOver(filePath: string): RoundComment[] {
  const review = loadReview(filePath);
  return loadAllComments(filePath).filter((c) => c.round !== review.currentRound && !c.resolved);
}

/**
 * エージェントに渡すコメント。現ラウンドを先に、その中は行順で返す。
 *
 * 持ち越しを廃止したので、ラウンド N の未解決コメントは N+1 の画面には出ない。
 * 画面から消えるだけなら履歴 (#4) で足りるが、エージェントに渡らないと指摘が失われる。
 * ラウンドを締める操作が「エージェントに渡す」の意味を持つので、締めた後も
 * 未解決のものは出し続ける。
 */
export function pendingComments(filePath: string, includeResolved = false): RoundComment[] {
  return loadAllComments(filePath)
    .filter((c) => includeResolved || !c.resolved)
    .toSorted((a, b) => b.round - a.round || a.startLine - b.startLine);
}

/**
 * ラウンドを指定せずにコメントの状態だけを更新する。
 *
 * 過去ラウンドの「読み取り専用」はスナップショットと行アンカーの話であって、
 * ステータスまで凍らせると未解決コメントを閉じる手段が無くなり、
 * `akapen comments` (#5) が同じ指摘を永遠に出し続ける。
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
