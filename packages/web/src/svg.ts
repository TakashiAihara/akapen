/**
 * Turn generated SVG markup into a node that is safe to put on the page.
 *
 * An SVG is XML, not a picture. It can carry `<script>`, event handlers and
 * `javascript:` links, and the text a figure is drawn from is written by whoever wrote
 * the document — which akapen does not assume is the reader. markdown-it runs with
 * `html: false` for that reason, and a figure must not be the way back in: this page
 * holds an authenticated session and shares an origin with `/api/comments` and with
 * `/api/doc`, which returns the file's absolute path.
 *
 * The list says what may stay rather than what must go. Graphviz emits a small fixed
 * vocabulary — nine elements over five kinds of graph — so enumerating it is both
 * shorter than the alternative and closed against whatever a future version, or another
 * renderer, decides to emit. `<foreignObject>` is the case that makes the difference:
 * it puts HTML inside an SVG, and it is exactly what a list of things-to-remove forgets.
 */

/** Elements graphviz produces, and nothing else. */
const ELEMENTS = new Set([
  'svg',
  'g',
  'title',
  'a',
  'path',
  'polygon',
  'polyline',
  'line',
  'rect',
  'circle',
  'ellipse',
  'text',
  'tspan',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
]);

/**
 * `<image>` is deliberately absent. Graphviz emits one for `image=`, and it would make
 * the document able to name a URL that the page then fetches. Serving files that sit
 * beside the document is its own decision (#81), not something a figure grants.
 */

const ATTRIBUTES = new Set([
  'class',
  'id',
  'transform',
  'viewBox',
  'preserveAspectRatio',
  'width',
  'height',
  'x',
  'y',
  'dx',
  'dy',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'xmlns',
  'xmlns:xlink',
  'xml:space',
  'xlink:title',
]);

/** Link targets that stay. Everything else, `javascript:` included, is dropped. */
const LINK_SCHEME = /^(?:https?:|mailto:|#|\/|\.{0,2}\/)/i;

function scrub(el: Element): void {
  // Snapshots, both of them. `children` and `attributes` are live, and this walk removes
  // from them as it goes: iterating the collection itself skips the entry after each
  // removal, which is how half of a list survives a filter that looks like it ran.
  for (const child of Array.from(el.children)) {
    if (!ELEMENTS.has(child.localName)) {
      child.remove();
      continue;
    }
    scrub(child);
  }

  for (const attr of Array.from(el.attributes)) {
    const name = attr.name;
    if (name === 'href' || name === 'xlink:href') {
      if (!LINK_SCHEME.test(attr.value.trim())) el.removeAttributeNode(attr);
      continue;
    }
    if (!ATTRIBUTES.has(name)) el.removeAttributeNode(attr);
  }
}

/**
 * Parse `markup` and return its root, with everything not on the lists above removed.
 *
 * Returns null when the markup does not parse as SVG at all, so a caller shows its own
 * message rather than an empty box.
 */
export function sanitizeSvg(markup: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.localName !== 'svg') return null;
  scrub(root);
  return root as unknown as SVGSVGElement;
}
