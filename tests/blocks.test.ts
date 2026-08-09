/**
 * 行マッピングの不変条件。
 *
 * 崩れると「指したい行が画面に存在しない」という最悪の壊れ方をする。
 * ここが akapen の土台なので、描画の見た目より先にこれを守る。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDoc } from '../src/blocks.ts';

const FIXTURE = join(import.meta.dirname, '..', 'examples', 'sample.md');
const source = readFileSync(FIXTURE, 'utf8');
const lines = source.split('\n');
const doc = buildDoc(FIXTURE, source);

describe('frontmatter', () => {
  const fm = doc.blocks.filter((b) => b.kind === 'frontmatter');

  it('1 ソース行 = 1 ブロックで割れる', () => {
    expect(fm.length).toBeGreaterThan(0);
    expect(fm.every((b) => b.startLine === b.endLine)).toBe(true);
  });

  it('key: value の 1 行を単独で指せる', () => {
    expect(fm.find((b) => b.text.startsWith('title:'))).toBeDefined();
    expect(fm.find((b) => b.text.trim().startsWith('status:'))).toBeDefined();
  });

  it('原文が改変されない (typographer で引用符が化けない)', () => {
    const title = fm.find((b) => b.text.startsWith('title:'))!;
    expect(title.text).toBe(lines[title.startLine - 1]);
  });
});

describe('行の割り当て', () => {
  const coverage = new Map<number, number>();
  for (const b of doc.blocks) {
    for (let ln = b.startLine; ln <= b.endLine; ln++) coverage.set(ln, (coverage.get(ln) ?? 0) + 1);
  }

  it('同じ行を 2 つのブロックが持たない', () => {
    expect([...coverage.entries()].filter(([, n]) => n > 1).map(([ln]) => ln)).toEqual([]);
  });

  it('空行以外のすべての行がどれかのブロックに属する', () => {
    const missing: number[] = [];
    for (let ln = 1; ln <= lines.length; ln++) {
      if (!lines[ln - 1]!.trim()) continue; // 空行は row を作らない (意図した設計)
      if (!coverage.has(ln)) missing.push(ln);
    }
    expect(missing).toEqual([]);
  });

  it('ブロックが行順に並ぶ', () => {
    expect(doc.blocks.filter((b, i) => i > 0 && b.startLine < doc.blocks[i - 1]!.startLine)).toEqual([]);
  });

  it('各ブロックの text が原文の該当行と一致する', () => {
    const mismatched = doc.blocks.filter(
      (b) => b.kind !== 'frontmatter' && b.text !== lines.slice(b.startLine - 1, b.endLine).join('\n'),
    );
    expect(mismatched.map((b) => b.startLine)).toEqual([]);
  });
});

describe('構造', () => {
  it('表の各行が列を落とさずに割れる', () => {
    const rows = doc.blocks.filter((b) => b.kind === 'table-row' && !b.flags.includes('table-separator'));
    expect(rows.length).toBeGreaterThan(0);
    const counts = new Set(rows.map((b) => (b.html.match(/<t[dh][ >]/g) ?? []).length));
    expect(counts.has(0)).toBe(false);
  });

  it('ネストしたリスト項目が深さ付きで割れる', () => {
    expect(doc.blocks.filter((b) => b.kind === 'list-item' && b.depth > 0).length).toBeGreaterThan(0);
  });
});
