/**
 * The document's headings, as the tree they already describe.
 *
 * Everything this needs is on the blocks the server already sends. A heading is
 * `kind: 'heading'`, its level is in `flags` as `h1` … `h6`, and where to go is
 * `startLine`. Nothing is added to the payload and nothing is parsed a second time.
 *
 * Anchors are deliberately not part of this. The usual outline points at an id derived
 * from the heading text, which is what makes two sections called "Open" collide. akapen
 * points at a line, and a line is unique whatever the heading says.
 *
 * DOM-free, so the derivation is testable without a browser (title.ts, same reason).
 */
import type { Block, Doc } from '@akapen/shared';
import { plainText } from './inline-text.ts';

export type OutlineEntry = {
  /** The heading's first source line. What the jump goes to. */
  line: number;
  /** 1 for h1 … 6 for h6. The level written in the document. */
  level: number;
  /**
   * How many headings this one sits under. 0 at the root.
   *
   * Kept apart from `level` because they disagree exactly where it matters. A document
   * going h1 → h3 has a level-3 heading one step in, and indenting it by its level would
   * leave a step of empty space standing for a heading that was never written.
   */
  depth: number;
  text: string;
  children: OutlineEntry[];
};

/** Markdown has six. */
export const DEEPEST_LEVEL = 6;

/**
 * How deep the outline goes unless it is asked for more.
 *
 * Past h3 an outline of a long note is long enough to need scrolling itself, and an
 * outline you have to search is not doing its job. The levels below are one control away.
 */
export const DEFAULT_DEEPEST = 3;

/**
 * A heading with no text at all (`##` on a line of its own) is legal markdown and is
 * rare. It still gets a row: leaving it out would silently reparent the section under it.
 * A row with nothing in it cannot be clicked, so it is shown as a dash.
 */
const UNTITLED = '—';

const LEVEL = /^h([1-6])$/;

function levelOf(block: Block): number | null {
  for (const flag of block.flags) {
    const m = LEVEL.exec(flag);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * A heading of the document itself: one that starts a section, and not one that happens
 * to be written inside something else.
 *
 * A heading inside a blockquote is left out. A quote is someone else's document copied
 * in, so its structure is not this document's — and a mail thread pasted into a note
 * would otherwise fill the outline with sections that are not there to go to.
 *
 * One inside a list item is left out for a sharper reason. `- # Heading` is a heading to
 * CommonMark, and taking it would reset the nesting: an h1 buried in a list becomes a
 * root, and every real section after it hangs underneath. The outline would then be
 * telling the reader a structure the document does not have.
 */
function outlineHeadings(doc: Doc): { block: Block; level: number }[] {
  const out: { block: Block; level: number }[] = [];
  for (const block of doc.blocks) {
    if (block.kind !== 'heading' || block.quoted || block.depth > 0) continue;
    const level = levelOf(block);
    if (level !== null) out.push({ block, level });
  }
  return out;
}

/** How many headings the outline could show at its deepest. Zero means the document has no structure to show. */
export function headingCount(doc: Doc): number {
  return outlineHeadings(doc).length;
}

/**
 * The heading tree, down to `deepest`.
 *
 * A level that is skipped does not break the nesting: an h3 under an h1 with no h2
 * between them becomes a child of the h1. Documents skip levels often enough that
 * refusing to nest them would be a bug in the reader, not in the document.
 *
 * A document that starts deep (h2, as anything with its title in frontmatter does) has
 * its h2s at the root. The tree is built from what is there, not from h1 downwards.
 */
export function buildOutline(doc: Doc, deepest: number = DEFAULT_DEEPEST): OutlineEntry[] {
  const roots: OutlineEntry[] = [];
  const stack: OutlineEntry[] = [];

  for (const { block, level } of outlineHeadings(doc)) {
    if (level > deepest) continue;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    const entry: OutlineEntry = {
      line: block.startLine,
      level,
      depth: stack.length,
      text: plainText(block.html) || UNTITLED,
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(entry);
    else roots.push(entry);
    stack.push(entry);
  }

  return roots;
}

/** The same entries in document order. What "which section am I in" reads. */
export function flattenOutline(entries: readonly OutlineEntry[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  for (const entry of entries) {
    out.push(entry);
    out.push(...flattenOutline(entry.children));
  }
  return out;
}
