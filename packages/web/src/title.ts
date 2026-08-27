/**
 * What the browser tab is called.
 *
 * The tab said `akapen` for every review, which is the one name that cannot tell two
 * of them apart — and akapen is read with several open at once, one per note. The
 * document already carries something that names it: its first top-level heading.
 *
 * Derived from the rendered HTML rather than the source line, so `# The **rail**` is a
 * tab called `The rail` and not `The **rail**`. That leaves entities to undo, which is
 * a closed set: markdown-it resolves the ones written in the source and escapes only
 * `& < > "` on the way out.
 *
 * Kept apart from app.ts, and free of the DOM, so the derivation can be tested without
 * a browser. The whole point is what the string ends up being.
 */
import type { Doc } from '@akapen/shared';

const BRAND = 'akapen';

/**
 * `&amp;` is undone last. Any earlier and `&amp;lt;` — an ampersand the document
 * actually contains — would come out as `<`.
 */
const ENTITIES: readonly (readonly [RegExp, string])[] = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#0*39;|&#[xX]0*27;/g, "'"],
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
];

/**
 * The text of rendered inline HTML. Tags carry no title, only what sits between them —
 * except an image, whose text is its alt. Dropping the tag with the rest took the name
 * off `# ![Project Logo](logo.png)` entirely, and a heading that is only an image then
 * fell through to the file name as if it had no heading at all.
 *
 * markdown-it always writes `alt` in double quotes and escapes any it finds inside, so
 * the value cannot close the attribute early. What it leaves behind is entities, which
 * the pass below is already there to undo.
 */
function plain(html: string): string {
  let out = html.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, '$1');
  out = out.replace(/<[^>]*>/g, '');
  for (const [pattern, char] of ENTITIES) out = out.replace(pattern, char);
  // A heading can be written across two lines (`Title` over `=====`), and a tab is one line.
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * The first top-level heading — `#` or the setext form, whichever the document uses.
 *
 * A document with two of them is unusual enough not to be designed for; taking the
 * first is what a reader would call the document anyway.
 */
function headingText(doc: Doc): string {
  const h1 = doc.blocks.find((b) => b.kind === 'heading' && b.flags.includes('h1'));
  return h1 ? plain(h1.html) : '';
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
