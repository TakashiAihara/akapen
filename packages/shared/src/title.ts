/**
 * What a document calls itself: its first top-level heading, with the markup taken off.
 *
 * Here rather than in packages/web because two places answer it. The browser tab is one
 * (packages/web/src/title.ts), `/api/status` — and so `akapen list --json` — is the
 * other (#169). A second derivation would drift from the tab's, and the one nobody is
 * looking at is the one that drifts.
 *
 * Empty when there is none. Both callers already hold the file name, so the fallback is
 * theirs to pick: the tab uses it, `list` reports it in its own column.
 */
import type { Block, Doc } from './contract.ts';
import { plainText } from './inline-text.ts';

/**
 * `#` or the setext form, whichever the document uses. A document with two is unusual
 * enough not to be designed for; the first is what a reader would call it anyway.
 *
 * Only a heading the document itself stands under counts (`isDocumentHeading`).
 */
export function documentTitle(doc: Doc): string {
  const h1 = doc.blocks.find((b) => isDocumentHeading(b) && b.flags.includes('h1'));
  return h1 ? plainText(h1.html) : '';
}

/**
 * A heading the document stands under, rather than one it quotes or lists: a heading in
 * a quote or a list item is something the document shows, not its structure or its name
 * (#197). Shared with the outline so the two readers of headings cannot drift apart.
 *
 * The kind is checked here rather than left to callers, because `quoted` and `depth`
 * only mean something for blocks the parser walked: gap lines and frontmatter always
 * carry depth 0, so on its own the test answered true for them (#202).
 */
export function isDocumentHeading(block: Block): boolean {
  return block.kind === 'heading' && !block.quoted && block.depth === 0;
}
