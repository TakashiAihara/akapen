/**
 * The reading of rendered inline HTML: what a heading says, with the markup taken off.
 *
 * Two places need exactly this. The tab title is one (title.ts), the outline is the
 * other — and both want `# The **rail**` to read as `The rail`. Deriving it twice would
 * mean two answers to "what does this heading say", and the one that is not being looked
 * at is the one that drifts.
 *
 * DOM-free on purpose, so what the string ends up being can be tested without a browser.
 * The whole point is the string.
 *
 * Tags are ended at the first `>`, quotes untracked. That holds because every tag
 * reaching here was written by markdown-it, configured `html: false` in
 * packages/core/src/blocks.ts, which puts `&gt;` or `%3E` in an attribute rather than
 * a raw `>`. The two settle together: reopen that decision and this needs a real
 * scanner first.
 */

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
 * Tags carry no text, only what sits between them — except an image, whose text is its
 * alt. Dropping the tag with the rest took the name off `# ![Project Logo](logo.png)`
 * entirely, and a heading that is only an image then read as if it had no text at all.
 *
 * markdown-it always writes `alt` in double quotes and escapes any it finds inside, so
 * the value cannot close the attribute early. What it leaves behind is entities, which
 * the pass below is already there to undo.
 */
export function plainText(html: string): string {
  let out = html.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, '$1');
  out = out.replace(/<[^>]*>/g, '');
  for (const [pattern, char] of ENTITIES) out = out.replace(pattern, char);
  // A heading can be written across two lines (`Title` over `=====`), and neither a tab
  // nor an outline row is two lines.
  return out.replace(/\s+/g, ' ').trim();
}
