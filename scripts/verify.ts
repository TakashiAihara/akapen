/**
 * PoC の判定ハーネス。
 * 「作るのが現実的か」を推測ではなく実測で答えるために、非自明な 3 点だけを検証する。
 *   1. frontmatter を 1 ソース行 = 1 ブロックで描けるか
 *   2. 表 / ネストリスト / フェンスで行がズレないか (行の取りこぼしと重複が無いか)
 *   3. ファイルが書き換わった後もコメントが同じ文を指し続けるか
 */
import { buildDoc } from '../src/blocks.ts';
import { makeComment, reanchor } from '../src/store.ts';

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

// --- 3. 再アンカー ---
console.log('');
const pickables = doc.blocks.filter((b) => b.kind === 'paragraph' || b.kind === 'list-item' || b.kind === 'heading');
const targets = [fm.find((b) => b.text.startsWith('status:'))!, pickables[3]!, pickables[Math.floor(pickables.length / 2)]!, pickables.at(-2)!].filter(Boolean);
const comments = targets.map((b, i) => makeComment(source, b.startLine, b.endLine, `テストコメント ${i + 1}`, 'verify'));

// エージェントの編集を模す: 冒頭に段落を足し、途中のセクションを書き換え、末尾に追記する
const edited = (() => {
  const l = lines.slice();
  l.splice(20, 0, '', 'エージェントが冒頭付近に足した段落。', '');
  const idx = l.findIndex((x, i) => i > 60 && x.startsWith('- '));
  if (idx >= 0) l[idx] = '- 書き換えられた項目。';
  l.push('', '## 追記', '', 'エージェントが末尾に足した節。');
  return l.join('\n');
})();

const moved = reanchor(comments, edited);
const editedLines = edited.split('\n');
for (const [i, c] of moved.entries()) {
  const before = comments[i]!;
  const nowText = editedLines.slice(c.startLine - 1, c.endLine).join('\n');
  const pointsAtSameText = !c.drifted && nowText === before.anchor;
  ok(
    `再アンカー ${i + 1}: L${before.startLine} → ${c.drifted ? 'drifted' : `L${c.startLine}`}`,
    pointsAtSameText,
    c.drifted ? '(原文が消えたので drifted。位置を推測していない)' : `"${nowText.slice(0, 36)}"`,
  );
}

// 原文が消えたコメントは黙って動かさず drifted になること
const removedTarget = pickables[3] ?? pickables[0];
if (!removedTarget) {
  console.log(`\n${failures === 0 ? 'すべて PASS' : `${failures} 件 FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}
const removed = lines.filter((_, i) => i !== removedTarget.startLine - 1).join('\n');
const [driftedComment] = reanchor([makeComment(source, removedTarget.startLine, removedTarget.endLine, 'x', 'verify')], removed);
ok('原文が消えたコメントは drifted になる (位置を推測しない)', driftedComment!.drifted === true);

console.log(`\n${failures === 0 ? 'すべて PASS' : `${failures} 件 FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
