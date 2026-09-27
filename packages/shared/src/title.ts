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
import type { Doc } from './contract.ts';
import { plainText } from './inline-text.ts';

/**
 * `#` or the setext form, whichever the document uses. A document with two is unusual
 * enough not to be designed for; the first is what a reader would call it anyway.
 *
 * Only a heading the document itself stands under: one in a quote or a list item is
 * something the document shows, not its name (#197). The same line the outline draws
 * (`outlineHeadings` in packages/web/src/outline.ts), so the two readers of headings agree.
 */
export function documentTitle(doc: Doc): string {
  const h1 = doc.blocks.find(
    (b) => b.kind === 'heading' && b.flags.includes('h1') && !b.quoted && b.depth === 0,
  );
  return h1 ? plainText(h1.html) : '';
}
