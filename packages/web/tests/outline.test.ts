/**
 * The heading tree.
 *
 * Built with the real parser rather than hand-written blocks, for the reason title.test.ts
 * gives: a fixture written by hand checks my idea of the parser's output instead of the
 * output, and keeps passing after the two stop agreeing.
 */
import { buildDoc } from '@akapen/core/blocks';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEEPEST, buildOutline, flattenOutline, headingCount } from '../src/outline.ts';

const doc = (source: string) => buildDoc('/home/x/notes/20-auth.md', source);

/** `h2 Title(4)` — level, text and line, which is everything a row is. */
const shape = (source: string, deepest?: number) =>
  flattenOutline(buildOutline(doc(source), deepest)).map((e) => `h${e.level} ${e.text}(${e.line})`);

/**
 * The tree as indentation, to say who is under whom rather than only what order they are in.
 *
 * Indented by each entry's own `depth` rather than by how far the walk has recursed, so
 * this is also the check that `depth` agrees with where the entry actually sits.
 */
function tree(source: string, deepest?: number): string {
  return flattenOutline(buildOutline(doc(source), deepest))
    .map((e) => '  '.repeat(e.depth) + e.text)
    .join('\n');
}

describe('buildOutline', () => {
  it('nests each heading under the one above its level', () => {
    expect(tree('# One\n\n## Two\n\n### Three\n\n## Two again\n')).toBe(
      ['One', '  Two', '    Three', '  Two again'].join('\n'),
    );
  });

  it('nests a heading that skips a level, rather than dropping it', () => {
    // h1 straight to h3 is common enough that refusing to nest it would be our bug
    expect(tree('# One\n\n### Three\n')).toBe(['One', '  Three'].join('\n'));
  });

  it('indents a skipped level by one step, not by the level that was never written', () => {
    // What the row is indented by. Two steps would stand for an h2 the document does not have
    const [one, three] = flattenOutline(buildOutline(doc('# One\n\n### Three\n')));
    expect([one?.level, one?.depth]).toEqual([1, 0]);
    expect([three?.level, three?.depth]).toEqual([3, 1]);
  });

  it('puts a document that starts deep at the root, instead of waiting for an h1', () => {
    // Anything carrying its title in frontmatter starts at h2
    expect(tree('## A\n\n### A1\n\n## B\n')).toBe(['A', '  A1', 'B'].join('\n'));
  });

  it('closes a deep section when a shallower heading follows it', () => {
    expect(tree('# One\n\n### Deep\n\n## Two\n')).toBe(['One', '  Deep', '  Two'].join('\n'));
  });

  it('reads a heading written under its text', () => {
    // The setext form spans two source lines, and the second one is the ===== itself
    expect(shape('The rail\n========\n')).toEqual(['h1 The rail(1)']);
  });

  it('drops inline markup, so a row reads as the heading reads', () => {
    expect(shape('# `token` and the **rail**\n')).toEqual(['h1 token and the rail(1)']);
  });

  it('restores characters the renderer escaped', () => {
    expect(shape('# a & b < c\n')).toEqual(['h1 a & b < c(1)']);
  });

  it('leaves out a heading inside a quote, because a quote is not this document', () => {
    expect(shape('# Mine\n\n> ## Theirs\n\n## Also mine\n')).toEqual(['h1 Mine(1)', 'h2 Also mine(5)']);
  });

  it('goes to h3 by default and no further', () => {
    expect(shape('# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n\n###### 6\n')).toEqual([
      'h1 1(1)',
      'h2 2(3)',
      'h3 3(5)',
    ]);
    expect(DEFAULT_DEEPEST).toBe(3);
  });

  it('goes to h6 when asked for all of them', () => {
    expect(shape('# 1\n\n## 2\n\n### 3\n\n#### 4\n\n##### 5\n\n###### 6\n', 6)).toEqual([
      'h1 1(1)',
      'h2 2(3)',
      'h3 3(5)',
      'h4 4(7)',
      'h5 5(9)',
      'h6 6(11)',
    ]);
  });

  it('keeps two headings that read the same apart, because a row points at a line', () => {
    // The usual outline derives an id from the text, and these two would collide
    expect(shape('## Open\n\n## Open\n')).toEqual(['h2 Open(1)', 'h2 Open(3)']);
  });

  it('gives a heading with no text a row anyway, so the section under it is not reparented', () => {
    expect(tree('# One\n\n##\n\n### Under the empty one\n')).toBe(
      ['One', '  —', '    Under the empty one'].join('\n'),
    );
  });

  it('has nothing to show for a document with no headings', () => {
    expect(buildOutline(doc('Just a paragraph.\n'))).toEqual([]);
  });

  it('ignores a # inside a code fence, which is not a heading at all', () => {
    expect(shape('```\n# not a heading\n```\n')).toEqual([]);
  });

  it('leaves out a heading written inside a list item, which would reset the nesting', () => {
    // CommonMark reads `- # Buried` as a heading. Taking it would make it a root and hang
    // every real section after it underneath.
    expect(tree('# One\n\n- # Buried\n\n## Two\n')).toBe(['One', '  Two'].join('\n'));
  });
});

describe('headingCount', () => {
  it('counts what the outline could ever show, whatever the depth is set to', () => {
    // The button and the "nothing at this depth" line are decided by this, not by buildOutline
    const source = '#### Deep only\n\n##### Deeper\n';
    expect(headingCount(doc(source))).toBe(2);
    expect(buildOutline(doc(source))).toEqual([]);
  });

  it('does not count a heading inside a quote', () => {
    expect(headingCount(doc('> # Theirs\n'))).toBe(0);
  });
});
