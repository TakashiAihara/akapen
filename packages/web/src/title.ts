/**
 * What the browser tab is called.
 *
 * The tab said `akapen` for every review, which is the one name that cannot tell two
 * of them apart — and akapen is read with several open at once, one per note. The
 * document already carries something that names it: its first top-level heading.
 *
 * What the heading says is packages/shared/src/title.ts, which `/api/status` shares so
 * `akapen list` names a document the way its tab does.
 *
 * Kept apart from app.ts, and free of the DOM, so the derivation can be tested without
 * a browser. The whole point is what the string ends up being.
 */
import type { Doc } from '@akapen/shared';
import { documentTitle } from '@akapen/shared/title';

const BRAND = 'akapen';

/** The name, never the path: a tab is too narrow to spend on directories. */
function fileName(path: string): string {
  return path.split(/[/\\]/).findLast(Boolean) ?? '';
}

/**
 * A heading, or the file name when there is none — a document with no top-level heading is
 * ordinary, and falling back to the brand would put us back where we started.
 */
export function pageTitle(doc: Doc): string {
  const name = documentTitle(doc) || fileName(doc.path);
  return name ? `${name} — ${BRAND}` : BRAND;
}
