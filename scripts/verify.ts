/**
 * PoC の判定ハーネス。
 * 「作るのが現実的か」を推測ではなく実測で答えるために、非自明な 3 点だけを検証する。
 *   1. frontmatter を 1 ソース行 = 1 ブロックで描けるか
 *   2. 表 / ネストリスト / フェンスで行がズレないか (行の取りこぼしと重複が無いか)
 *   3. ラウンドが凍結として機能するか (live の書き換えが過去ラウンドに波及しないか)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDoc } from '../src/blocks.ts';
import {
  carriedOver,
  ensureRound,
  loadAllComments,
  loadComments,
  loadReview,
  makeComment,
  openRound,
  roundContent,
  roundNumbersOnDisk,
  saveComments,
  storeDir,
  updateComment,
} from '../src/store.ts';

const target = process.argv[2];
if (!target) {
  console.error('usage: bun run scripts/verify.ts <file.md>');
  process.exit(1);
}

const source = await Bun.file(target).text();
const lines = source.split('\n');
const doc = buildDoc(target, source);

let failures = 0;
const ok = (label: string, pass: boolean, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

console.log(`file    ${target}`);
console.log(`lines   ${doc.lineCount}`);
console.log(`blocks  ${doc.blocks.length}\n`);

// --- 1. frontmatter ---
const fm = doc.blocks.filter((b) => b.kind === 'frontmatter');
const fmPerLine = fm.every((b) => b.startLine === b.endLine);
ok('frontmatter が 1 行 = 1 ブロック', fm.length > 0 && fmPerLine, `${fm.length} blocks`);
const titleBlock = fm.find((b) => b.text.startsWith('title:'));
ok('frontmatter の title 行を単独で指せる', !!titleBlock, titleBlock ? `L${titleBlock.startLine}` : '');
const statusBlock = fm.find((b) => b.text.trim().startsWith('status:'));
ok('frontmatter の status 行を単独で指せる', !!statusBlock, statusBlock ? `L${statusBlock.startLine}` : '');
ok(
  'frontmatter の原文が改変されていない (typographer で引用符が化けない)',
  titleBlock ? titleBlock.text === lines[titleBlock.startLine - 1] : false,
);

// --- 2. 行マッピング ---
const coverage = new Map<number, number>();
for (const b of doc.blocks) {
  for (let ln = b.startLine; ln <= b.endLine; ln++) coverage.set(ln, (coverage.get(ln) ?? 0) + 1);
}
const duplicated = [...coverage.entries()].filter(([, n]) => n > 1).map(([ln]) => ln);
ok('同じ行を 2 つのブロックが持たない', duplicated.length === 0, duplicated.slice(0, 8).join(','));

const missing: number[] = [];
for (let ln = 1; ln <= lines.length; ln++) {
  if (!lines[ln - 1]!.trim()) continue; // 空行は row を作らない (これが意図した設計)
  if (!coverage.has(ln)) missing.push(ln);
}
ok('空行以外のすべての行がどれかのブロックに属する', missing.length === 0, missing.slice(0, 12).join(','));

const outOfOrder = doc.blocks.filter((b, i) => i > 0 && b.startLine < doc.blocks[i - 1]!.startLine);
ok('ブロックが行順に並んでいる', outOfOrder.length === 0);

const mismatched = doc.blocks.filter(
  (b) => b.kind !== 'frontmatter' && b.text !== lines.slice(b.startLine - 1, b.endLine).join('\n'),
);
ok('各ブロックの text が原文の該当行と一致する', mismatched.length === 0, `${mismatched.length} blocks`);

for (const kind of ['table-row', 'list-item', 'code', 'mermaid', 'heading', 'paragraph'] as const) {
  const n = doc.blocks.filter((b) => b.kind === kind).length;
  console.log(`        ${kind.padEnd(12)} ${n}`);
}

// 表: ヘッダ行とデータ行が同じ列数で割れているか
const tableRows = doc.blocks.filter((b) => b.kind === 'table-row' && !b.flags.includes('table-separator'));
const colCounts = new Set(tableRows.map((b) => (b.html.match(/<t[dh][ >]/g) ?? []).length));
ok('表の各行が列を落とさずに割れている', tableRows.length > 0 && !colCounts.has(0), `列数の種類: ${[...colCounts].join(',')}`);

// ネストリスト: depth が 1 以上のブロックが存在するか
const nested = doc.blocks.filter((b) => b.kind === 'list-item' && b.depth > 0);
ok('ネストしたリスト項目が深さ付きで割れている', nested.length > 0, `${nested.length} items`);

// --- 3. ラウンドの凍結 ---
// 実ストアを汚さないよう AKAPEN_HOME を temp に向ける。対象の md 自体もコピーを使う。
console.log('');
const sandbox = mkdtempSync(join(tmpdir(), 'akapen-verify-'));
process.env.AKAPEN_HOME = join(sandbox, 'home');
const work = join(sandbox, 'note.md');
writeFileSync(work, source);

const r1 = ensureRound(work, source);
ok('最初のラウンドが開く', r1.currentRound === 1, `R${String(r1.currentRound).padStart(3, '0')}`);
ok('スナップショットが原文と一致する', roundContent(work, 1) === source);

const pickables = doc.blocks.filter((b) => b.kind === 'paragraph' || b.kind === 'list-item' || b.kind === 'heading');
// 足りない対象を黙って落とすと、コメント数が減ったまま PASS してカバレッジが縮む。
// 「対象が無い」は検証結果ではなく fixture の不備なので、ここで止める。
const targets = [
  fm.find((b) => b.text.startsWith('status:')),
  pickables[3],
  pickables[Math.floor(pickables.length / 2)],
  pickables.at(-2),
];
if (targets.some((b) => !b)) {
  console.error(`検証対象のブロックが揃っていません: ${target} に frontmatter の status 行と本文ブロック 4 つが要ります`);
  process.exit(1);
}
const comments = targets.map((b, i) => makeComment(source, b!.startLine, b!.endLine, `テストコメント ${i + 1}`, 'verify'));
saveComments(work, 1, comments);

const snap1 = roundContent(work, 1).split('\n');
const anchorsMatch = comments.every((c) => snap1.slice(c.startLine - 1, c.endLine).join('\n') === c.anchor);
ok('コメントの anchor がスナップショットの該当行と一致する', anchorsMatch, `${comments.length} 件`);

// エージェントの編集を模す: 冒頭に段落を足し、途中のセクションを書き換え、末尾に追記する
const edited = (() => {
  const l = lines.slice();
  l.splice(20, 0, '', 'エージェントが冒頭付近に足した段落。', '');
  const idx = l.findIndex((x, i) => i > 60 && x.startsWith('- '));
  if (idx >= 0) l[idx] = '- 書き換えられた項目。';
  l.push('', '## 追記', '', 'エージェントが末尾に足した節。');
  return l.join('\n');
})();
writeFileSync(work, edited);

// live を書き換えても、ラウンドを切るまで凍結側は動かない
ok('live を書き換えても現ラウンドのスナップショットは変わらない', roundContent(work, 1) === source);
ok('live を書き換えても現ラウンドのコメントは動かない', JSON.stringify(loadComments(work, 1)) === JSON.stringify(comments));

const r2 = openRound(work, edited);
ok('ラウンドを切ると番号が進む', r2.currentRound === 2, `R001 → R${String(r2.currentRound).padStart(3, '0')}`);
ok('新ラウンドのスナップショットが編集後の内容になる', roundContent(work, 2) === edited);
ok('新ラウンドにコメントを持ち越さない', loadComments(work, 2).length === 0);
ok('過去ラウンドのスナップショットが不変', roundContent(work, 1) === source);
ok('過去ラウンドのコメントが不変', JSON.stringify(loadComments(work, 1)) === JSON.stringify(comments));
ok('前のラウンドが閉じた時刻を持つ', r2.rounds.find((r) => r.n === 1)?.closedAt != null);

// 当時の本文 + 当時の行番号で、指した箇所がそのまま再現できること (W-4 の前提)
const reproducible = comments.every(
  (c) => roundContent(work, 1).split('\n').slice(c.startLine - 1, c.endLine).join('\n') === c.anchor,
);
ok('ラウンド番号 + content.md + 行番号で指摘箇所を再現できる', reproducible);

// review.json はメタ情報でしかない。これを失って凍結済みの本文が消えるのが最悪の壊れ方なので、
// 壊れた場合と消えた場合の両方でラウンドの実体を守れることを見る。
for (const [label, corrupt] of [
  ['壊れた', () => writeFileSync(join(storeDir(work), 'review.json'), '{ broken')],
  ['消えた', () => rmSync(join(storeDir(work), 'review.json'))],
  ['rounds が配列でない', () => writeFileSync(join(storeDir(work), 'review.json'), '{"currentRound":2,"rounds":{}}')],
] as const) {
  corrupt();
  const recovered = loadReview(work);
  ok(`${label} review.json からラウンド番号を復元する`, recovered.currentRound === 2, `R${String(recovered.currentRound).padStart(3, '0')}`);

  ensureRound(work, edited);
  ok(
    `${label} review.json でも凍結済みのラウンドを上書きしない`,
    roundContent(work, 1) === source && JSON.stringify(loadComments(work, 1)) === JSON.stringify(comments),
  );
}

// review.json が古い番号を指していても、実体のあるラウンドを踏まない
writeFileSync(join(storeDir(work), 'review.json'), JSON.stringify({ version: 2, currentRound: 1, rounds: [] }));
const r4 = openRound(work, edited);
ok('古い review.json でも既存ラウンドを踏まずに次を開く', r4.currentRound === 3, `R${String(r4.currentRound).padStart(3, '0')}`);
ok('踏まれていないこと (R001 / R002 が不変)', roundContent(work, 1) === source && roundContent(work, 2) === edited);
ok('R003 の実体が作られている', roundContent(work, 3) === edited && loadComments(work, 3).length === 0);

// --- 4. ラウンドをまたいだ読み取り ---
// 持ち越さない設計なので、「過去に何を指摘したか」は横断読みでしか分からない。
// UI の履歴も comments の受け渡しもここに乗るため、崩れると指摘が静かに失われる。
console.log('');
const all = loadAllComments(work);
ok('全ラウンドのコメントを横断して読める', all.length === comments.length, `${all.length} 件`);
// review.json が古くてもディスク上のラウンドを取りこぼさないこと (直前の節でわざと古くしてある)
ok(
  'review.json に載っていないラウンドも横断読みに入る',
  new Set(loadAllComments(work).map((c) => c.round)).size >= 1 &&
    roundNumbersOnDisk(work).every((n) => loadReview(work).rounds.some((r) => r.n === n)),
  `disk: ${roundNumbersOnDisk(work).join(',')} / review: ${loadReview(work).rounds.map((r) => r.n).join(',')}`,
);
ok('新しいラウンドから順に並ぶ', all.every((c, i) => i === 0 || all[i - 1]!.round >= c.round));
ok('どのラウンドのものか付いている', all.every((c) => c.round === 1));

// R001 の 1 件を解決して、未解決だけが持ち越し扱いになること
const closing = comments[0]!;
const updated = updateComment(work, closing.id, (c) => {
  c.resolved = true;
});
ok('ラウンドを指定せずコメントを更新できる', updated?.round === 1 && updated.resolved === true);
ok('更新が R001 の comments.json に書かれている', loadComments(work, 1).find((c) => c.id === closing.id)?.resolved === true);

const carried = carriedOver(work);
ok('現ラウンド (R003) より前の未解決だけが持ち越しに出る', carried.length === comments.length - 1, `${carried.length} 件`);
ok('解決済みは持ち越しに出ない', !carried.some((c) => c.id === closing.id));
ok('現ラウンドのコメントは持ち越しに混ざらない', carried.every((c) => c.round !== loadReview(work).currentRound));

ok('存在しない id の更新は null を返す', updateComment(work, 'c_nope', () => {}) === null);

console.log(`\n${failures === 0 ? 'すべて PASS' : `${failures} 件 FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
