/**
 * What the browser tab is called.
 *
 * The tab said `akapen` for every review, which is the one name that cannot tell two
 * of them apart — and akapen is read with several open at once, one per note. The
 * document already carries something that names it: its first top-level heading.
 *
 * Derived from the rendered HTML rather than the source line, so `# The **rail**` is a
 * tab called `The rail` and not `The **rail**`. Reading the markup off is inline-text.ts,
 * which the outline shares.
 *
 * Kept apart from app.ts, and free of the DOM, so the derivation can be tested without
 * a browser. The whole point is what the string ends up being.
 */
import type { Doc } from '@akapen/shared';
import { plainText } from './inline-text.ts';

const BRAND = 'akapen';

/**
 * The first top-level heading — `#` or the setext form, whichever the document uses.
 *
 * A document with two of them is unusual enough not to be designed for; taking the
 * first is what a reader would call the document anyway.
 */
function headingText(doc: Doc): string {
  const h1 = doc.blocks.find((b) => b.kind === 'heading' && b.flags.includes('h1'));
  return h1 ? plainText(h1.html) : '';
}

/** The name, never the path: a tab is too narrow to spend on directories. */
function fileName(path: string): string {
  return path.split(/[/\\]/).findLast(Boolean) ?? '';
}

/**
 * A heading, or the file name when there is none — a document with no top-level heading is
 * ordinary, and falling back to the brand would put us back where we started.
 */
export function pageTitle(doc: Doc): string {
  const name = headingText(doc) || fileName(doc.path);
  return name ? `${name} — ${BRAND}` : BRAND;
}
