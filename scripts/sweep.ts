/**
 * 行マッピングの不変条件を vault の全ノートに対して確認する。
 * ノート 1 本で通っても意味が薄い (1 サンプルからの一般化)。
 *   - 空行以外のすべての行がちょうど 1 つのブロックに属する
 *   - ブロックの text が原文の該当行と一致する
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildDoc } from '../src/blocks.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: bun run scripts/sweep.ts <dir>');
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
let bad = 0;
let totalBlocks = 0;
const kinds = new Map<string, number>();

for (const f of files) {
  const path = join(dir, f);
  const source = await Bun.file(path).text();
  const lines = source.split('\n');
  let doc;
  try {
    doc = buildDoc(path, source);
  } catch (e) {
    console.log(`THROW  ${f}  ${(e as Error).message}`);
    bad++;
    continue;
  }
  totalBlocks += doc.blocks.length;

  const coverage = new Map<number, number>();
  for (const b of doc.blocks) {
    kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
    for (let ln = b.startLine; ln <= b.endLine; ln++) coverage.set(ln, (coverage.get(ln) ?? 0) + 1);
  }

  const dup = [...coverage.entries()].filter(([, n]) => n > 1).map(([ln]) => ln);
  const missing: number[] = [];
  for (let ln = 1; ln <= lines.length; ln++) {
    if (lines[ln - 1]!.trim() && !coverage.has(ln)) missing.push(ln);
  }
  const mismatched = doc.blocks.filter(
    (b) => b.kind !== 'frontmatter' && b.text !== lines.slice(b.startLine - 1, b.endLine).join('\n'),
  );

  if (dup.length || missing.length || mismatched.length) {
    bad++;
    console.log(
      `FAIL   ${f}  dup=${dup.slice(0, 5).join(',') || '-'}  missing=${missing.slice(0, 5).join(',') || '-'}  mismatch=${mismatched.length}`,
    );
  }
}

console.log(`\nfiles ${files.length}  failed ${bad}  blocks ${totalBlocks}`);
console.log([...kinds.entries()].map(([k, n]) => `${k}=${n}`).join('  '));
process.exit(bad === 0 ? 0 : 1);
