/**
 * Check the line-mapping invariants across every note in a directory.
 * Passing on a single note proves little — that is generalising from one sample.
 *   - every non-blank line belongs to exactly one block
 *   - each block's text equals its source lines
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
