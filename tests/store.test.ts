/**
 * ラウンドの保存層。
 *
 * ここが崩れると、凍結したはずの本文と指摘が静かに消える。実際 #4 の実装中に
 * loadAllComments が review.json を信じてディスク上のラウンドを取りこぼしていた。
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

const SOURCE = ['---', 'title: t', 'status: active', '---', '', '# 見出し', '', '段落。', '', '- 項目', ''].join('\n');
const EDITED = `${SOURCE}\n## 追記\n\nエージェントが直した。\n`;

let sandbox: string;
let work: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'akapen-test-'));
  process.env.AKAPEN_HOME = join(sandbox, 'home');
  work = join(sandbox, 'note.md');
  writeFileSync(work, SOURCE);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.AKAPEN_HOME;
});

/** R001 に n 件、そのうち先頭を resolve 済みにして返す */
function seed(): Comment[] {
  ensureRound(work, SOURCE);
  const comments = [
    makeComment(SOURCE, 3, 3, 'status への指摘', 't'),
    makeComment(SOURCE, 6, 6, '見出しへの指摘', 't'),
    makeComment(SOURCE, 8, 8, '段落への指摘', 't'),
  ];
  saveComments(work, 1, comments);
  return comments;
}

describe('ラウンドの凍結', () => {
  it('最初のラウンドが開き、スナップショットが原文と一致する', () => {
    expect(ensureRound(work, SOURCE).currentRound).toBe(1);
    expect(roundContent(work, 1)).toBe(SOURCE);
  });

  it('コメントの anchor がスナップショットの該当行と一致する', () => {
    const comments = seed();
    const snap = roundContent(work, 1).split('\n');
    for (const c of comments) {
      expect(snap.slice(c.startLine - 1, c.endLine).join('\n')).toBe(c.anchor);
    }
  });

  it('live を書き換えても現ラウンドは動かない', () => {
    const comments = seed();
    writeFileSync(work, EDITED);
    expect(roundContent(work, 1)).toBe(SOURCE);
    expect(loadComments(work, 1)).toEqual(comments);
  });

  it('ラウンドを切ると番号が進み、コメントを持ち越さない', () => {
    const comments = seed();
    const r2 = openRound(work, EDITED);
    expect(r2.currentRound).toBe(2);
    expect(roundContent(work, 2)).toBe(EDITED);
    expect(loadComments(work, 2)).toEqual([]);
    expect(roundContent(work, 1)).toBe(SOURCE);
    expect(loadComments(work, 1)).toEqual(comments);
    expect(r2.rounds.find((r) => r.n === 1)?.closedAt).not.toBeNull();
  });

  it('ラウンド番号 + content.md + 行番号で指摘箇所を再現できる', () => {
    const comments = seed();
    openRound(work, EDITED);
    const snap = roundContent(work, 1).split('\n');
    for (const c of comments) {
      expect(snap.slice(c.startLine - 1, c.endLine).join('\n')).toBe(c.anchor);
    }
  });
});

describe('review.json を失っても実体を守る', () => {
  // 凍結した本文が消えるのがこの設計で最悪の壊れ方。review.json はメタ情報でしかない。
  const broken: [string, (dir: string) => void][] = [
    ['壊れている', (dir) => writeFileSync(join(dir, 'review.json'), '{ broken')],
    ['消えている', (dir) => rmSync(join(dir, 'review.json'))],
    ['rounds が配列でない', (dir) => writeFileSync(join(dir, 'review.json'), '{"currentRound":2,"rounds":{}}')],
  ];

  for (const [label, corrupt] of broken) {
    it(`${label} 時にラウンド番号を復元し、既存ラウンドを上書きしない`, () => {
      const comments = seed();
      openRound(work, EDITED);
      corrupt(storeDir(work));

      expect(loadReview(work).currentRound).toBe(2);
      ensureRound(work, EDITED);
      expect(roundContent(work, 1)).toBe(SOURCE);
      expect(loadComments(work, 1)).toEqual(comments);
    });
  }

  it('古い番号を指す review.json でも既存ラウンドを踏まない', () => {
    seed();
    openRound(work, EDITED);
    writeFileSync(join(storeDir(work), 'review.json'), JSON.stringify({ version: 2, currentRound: 1, rounds: [] }));

    const r3 = openRound(work, EDITED);
    expect(r3.currentRound).toBe(3);
    expect(roundContent(work, 1)).toBe(SOURCE);
    expect(roundContent(work, 3)).toBe(EDITED);
    expect(loadComments(work, 3)).toEqual([]);
  });

  it('review.json に載っていないラウンドも横断読みに入る', () => {
    seed();
    openRound(work, EDITED);
    writeFileSync(join(storeDir(work), 'review.json'), JSON.stringify({ version: 2, currentRound: 1, rounds: [] }));

    const known = loadReview(work).rounds.map((r) => r.n);
    expect(roundNumbersOnDisk(work).every((n) => known.includes(n))).toBe(true);
    expect(loadAllComments(work).length).toBe(3);
  });

  it('ラウンドがまだ無い場合だけ新しく開く', () => {
    mkdirSync(storeDir(work), { recursive: true });
    expect(loadReview(work).currentRound).toBe(0);
    expect(ensureRound(work, SOURCE).currentRound).toBe(1);
    expect(ensureRound(work, SOURCE).currentRound).toBe(1);
  });
});

describe('ラウンドをまたいだ読み取り', () => {
  it('全ラウンドを新しい順に、round 付きで返す', () => {
    seed();
    openRound(work, EDITED);
    saveComments(work, 2, [makeComment(EDITED, 6, 6, 'R002 の指摘', 't')]);

    const all = loadAllComments(work);
    expect(all.length).toBe(4);
    expect(all.every((c, i) => i === 0 || all[i - 1]!.round >= c.round)).toBe(true);
    expect(new Set(all.map((c) => c.round))).toEqual(new Set([1, 2]));
  });

  it('ラウンドを指定せず id で更新できる', () => {
    const comments = seed();
    openRound(work, EDITED);

    const updated = updateComment(work, comments[0]!.id, (c) => {
      c.resolved = true;
    });
    expect(updated?.round).toBe(1);
    expect(loadComments(work, 1).find((c) => c.id === comments[0]!.id)?.resolved).toBe(true);
    expect(updateComment(work, 'c_nope', () => {})).toBeNull();
  });

  it('持ち越しは現ラウンドより前の未解決だけ', () => {
    const comments = seed();
    updateComment(work, comments[0]!.id, (c) => {
      c.resolved = true;
    });
    openRound(work, EDITED);
    saveComments(work, 2, [makeComment(EDITED, 6, 6, 'R002 の指摘', 't')]);

    const carried = carriedOver(work);
    expect(carried.map((c) => c.body)).toEqual(['見出しへの指摘', '段落への指摘']);
    expect(carried.every((c) => c.round === 1)).toBe(true);
  });
});

describe('エージェントへの受け渡し', () => {
  it('締めた後も未解決なら出し続ける', () => {
    seed();
    expect(pendingComments(work).length).toBe(3);
    openRound(work, EDITED);
    // ここが 0 件になっていたのが #3 で開いていた穴
    expect(pendingComments(work).length).toBe(3);
  });

  it('現ラウンドが先、その中は行順', () => {
    seed();
    openRound(work, EDITED);
    const fresh = makeComment(EDITED, 6, 6, 'R002 の指摘', 't');
    saveComments(work, 2, [fresh]);

    const pending = pendingComments(work);
    expect(pending[0]!.id).toBe(fresh.id);
    expect(pending.map((c) => `R${c.round}:L${c.startLine}`)).toEqual(['R2:L6', 'R1:L3', 'R1:L6', 'R1:L8']);
  });

  it('解決済みは既定で出さず、指定すれば出す', () => {
    const comments = seed();
    updateComment(work, comments[0]!.id, (c) => {
      c.resolved = true;
    });
    expect(pendingComments(work).length).toBe(2);
    expect(pendingComments(work, true).length).toBe(3);
  });

  it('当時の原文が付く', () => {
    seed();
    expect(pendingComments(work).every((c) => c.anchor.length > 0)).toBe(true);
  });
});
