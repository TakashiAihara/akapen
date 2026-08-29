/**
 * Line-mapping invariants.
 *
 * Break them and you get the worst failure there is: the line you want to point at
 * is not on the screen. This is what akapen stands on, so it comes before looks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDoc } from '../src/blocks.ts';

// The repository's own sample, not a copy: it is the file the README tells you to open,
// so a split that breaks on it breaks the first thing anyone sees.
const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'examples', 'sample.md');
const source = readFileSync(FIXTURE, 'utf8');
const lines = source.split('\n');
const doc = buildDoc(FIXTURE, source);

describe('frontmatter', () => {
  const fm = doc.blocks.filter((b) => b.kind === 'frontmatter');

  it('splits into one block per source line', () => {
    expect(fm.length).toBeGreaterThan(0);
    expect(fm.every((b) => b.startLine === b.endLine)).toBe(true);
  });

  it('lets a single key: value line be addressed', () => {
    expect(fm.find((b) => b.text.startsWith('title:'))).toBeDefined();
    expect(fm.find((b) => b.text.trim().startsWith('status:'))).toBeDefined();
  });

  it('leaves the source untouched (typographer does not mangle quotes)', () => {
    const title = fm.find((b) => b.text.startsWith('title:'))!;
    expect(title.text).toBe(lines[title.startLine - 1]);
  });
});

describe('line coverage', () => {
  const coverage = new Map<number, number>();
  for (const b of doc.blocks) {
    for (let ln = b.startLine; ln <= b.endLine; ln++) coverage.set(ln, (coverage.get(ln) ?? 0) + 1);
  }

  it('never puts one line in two blocks', () => {
    expect([...coverage.entries()].filter(([, n]) => n > 1).map(([ln]) => ln)).toEqual([]);
  });

  it('puts every non-blank line in some block', () => {
    const missing: number[] = [];
    for (let ln = 1; ln <= lines.length; ln++) {
      if (!lines[ln - 1]!.trim()) continue; // blank lines get no row, by design
      if (!coverage.has(ln)) missing.push(ln);
    }
    expect(missing).toEqual([]);
  });

  it('keeps blocks in line order', () => {
    expect(doc.blocks.filter((b, i) => i > 0 && b.startLine < doc.blocks[i - 1]!.startLine)).toEqual([]);
  });

  it('keeps each block text equal to its source lines', () => {
    const mismatched = doc.blocks.filter(
      (b) => b.kind !== 'frontmatter' && b.text !== lines.slice(b.startLine - 1, b.endLine).join('\n'),
    );
    expect(mismatched.map((b) => b.startLine)).toEqual([]);
  });
});

describe('structure', () => {
  it('splits table rows without dropping columns', () => {
    const rows = doc.blocks.filter((b) => b.kind === 'table-row' && !b.flags.includes('table-separator'));
    expect(rows.length).toBeGreaterThan(0);
    const counts = new Set(rows.map((b) => (b.html.match(/<t[dh][ >]/g) ?? []).length));
    expect(counts.has(0)).toBe(false);
  });

  it('splits nested list items with their depth', () => {
    expect(doc.blocks.filter((b) => b.kind === 'list-item' && b.depth > 0).length).toBeGreaterThan(0);
  });
});

const kindsOf = (md: string) => [...new Set(buildDoc('t.md', md).blocks.map((b) => b.kind))];

/** A fenced block with the given info string, holding something mermaid can draw. */
const fence = (info: string) => `\`\`\`${info}\ngraph TD\n  A-->B\n\`\`\``;

describe('fence info strings', () => {
  it.each([['mermaid'], ['Mermaid'], ['MERMAID'], ['mermaid title="x"'], ['Mermaid  title="x"']])(
    'renders ```%s as a diagram',
    (info) => {
      // A language name is case-insensitive to anyone writing markdown. Comparing the raw
      // string made a capitalised fence come out as an ordinary code block, with nothing
      // said about why — it just was not a diagram.
      expect(kindsOf(fence(info))).toEqual(['mermaid']);
    },
  );

  it.each([['dot'], ['DOT'], ['graphviz'], ['Graphviz'], ['dot rankdir=LR']])(
    'renders ```%s as a graphviz figure',
    (info) => {
      expect(kindsOf(fence(info))).toEqual(['dot']);
    },
  );

  it.each([['constructor'], ['toString'], ['valueOf'], ['hasOwnProperty'], ['__proto__']])(
    'leaves ```%s as code, rather than finding it on Object.prototype',
    (info) => {
      // The lookup is by a name taken straight from the document. Against an object
      // literal, `constructor` and its siblings are found on the prototype: the fence
      // becomes a figure whose kind is undefined, which is not a kind the contract has.
      expect(kindsOf(fence(info))).toEqual(['code']);
    },
  );

  it.each([['ts'], ['TypeScript'], [''], ['mermaidjs'], ['not-mermaid'], ['dotenv'], ['graphviz-dot']])(
    'leaves ```%s as code',
    (info) => {
      // Only the whole first word counts. A fence that merely starts with the letters
      // must not be swallowed.
      expect(kindsOf(fence(info))).toEqual(['code']);
    },
  );

  it('highlights a language whatever case it is written in', () => {
    // hljs.getLanguage folds case itself, so this is a guard rather than a fix.
    const upper = buildDoc('t.md', '```TypeScript\nconst a: number = 1;\n```');
    const lower = buildDoc('t.md', '```typescript\nconst a: number = 1;\n```');
    expect(upper.blocks.some((b) => b.html.includes('hljs-'))).toBe(true);
    expect(upper.blocks.map((b) => b.html.replace(/TypeScript/g, 'typescript'))).toEqual(
      lower.blocks.map((b) => b.html),
    );
  });
});

describe('a document that is not markdown', () => {
  const SCHEMA = ['Table users {', '  id integer [pk]', '  note varchar [note: "__pending__"]', '}'].join(
    '\n',
  );

  it('opens a .dbml file as one figure over the whole file', () => {
    const built = buildDoc('/tmp/schema.dbml', SCHEMA);
    expect(built.blocks).toHaveLength(1);
    expect(built.blocks[0]?.kind).toBe('dbml');
    // Lines 1..N of the file as it is on disk. Built over a synthesised fence instead,
    // the opening fence would take line 1 and every comment would be off by one against
    // the file its writer is editing.
    expect([built.blocks[0]?.startLine, built.blocks[0]?.endLine]).toEqual([1, 4]);
    expect(built.lineCount).toBe(4);
  });

  it('does not let markdown rewrite the source on the way to the screen', () => {
    // `__pending__` in a note is the document's text, not emphasis. Read as markdown it
    // arrives as <strong>pending</strong>, and what is under review is no longer what is
    // on disk.
    const html = buildDoc('/tmp/schema.dbml', SCHEMA).blocks[0]?.html ?? '';
    expect(html).not.toContain('<strong>');
    expect(html).toContain('__pending__');
  });

  it.each([['/tmp/schema.DBML'], ['/tmp/a.b.dbml']])('recognises %s by its extension', (path) => {
    expect(buildDoc(path, SCHEMA).blocks.map((b) => b.kind)).toEqual(['dbml']);
  });

  it.each([['/tmp/note.md'], ['/tmp/schema.dbml.md'], ['/tmp/dbml'], ['/tmp/schema.dbmlx']])(
    'still reads %s as markdown',
    (path) => {
      // The extension is the whole of it. A name that merely contains the letters is a
      // markdown file, and reading it as a schema would show one unaddressable figure
      // where a document belongs.
      expect(buildDoc(path, SCHEMA).blocks.every((b) => b.kind !== 'dbml')).toBe(true);
    },
  );

  it.each([['/tmp/constructor'], ['/tmp/x.constructor'], ['/tmp/x.__proto__']])(
    'does not find %s on Object.prototype',
    (path) => {
      expect(buildDoc(path, SCHEMA).blocks.every((b) => b.kind !== 'dbml')).toBe(true);
    },
  );
});
