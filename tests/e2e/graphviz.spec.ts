/**
 * Graphviz figures, drawn in the browser.
 *
 * Three things only a real browser answers. That the wasm engine reaches the page from
 * akapen itself and not from the network; that a graph a document made unrenderable
 * leaves its source on screen; and that what ends up in the DOM carries nothing
 * executable. The last is the reason this file is not a unit test — a string search over
 * generated markup matches entity-escaped text and reports the opposite of the truth,
 * which is a mistake that was actually made while designing this.
 */
import { expect, test } from './fixtures.ts';

const GRAPH = ['```dot', 'digraph { rankdir=LR; a -> b; b -> c }', '```'].join('\n');

/** Append a fence and cut a round, which is how new content reaches the screen. */
async function show(
  page: import('@playwright/test').Page,
  akapen: { url: string; append: (t: string) => void },
  body: string,
) {
  await page.goto(akapen.url);
  await expect(page.locator('.row').first()).toBeVisible();
  akapen.append(`\n${body}\n`);
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
}

test('draws a dot fence, without reaching the network for the engine', async ({ page, akapen }) => {
  const offSite: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(akapen.url)) offSite.push(r.url());
  });

  await show(page, akapen, GRAPH);

  const svg = page.locator('.graphviz-block svg');
  await expect(svg).toBeVisible();
  // The nodes are in the picture, so this is the drawing rather than an empty frame
  await expect(svg).toContainText('a');
  await expect(svg).toContainText('c');

  // Everything the page loaded came from akapen. The engine's own source calls fetch for
  // its wasm; bundling inlines it, and that is what this holds in place.
  expect(offSite).toEqual([]);
});

test('keeps the source on screen when the graph does not compile', async ({ page, akapen }) => {
  await show(page, akapen, ['```dot', 'digraph { a -> }', '```'].join('\n'));

  // The message first. Drawing is asynchronous — the engine has to load before it can
  // fail — so asserting on the source before then finds the source that has not been
  // touched yet, and passes whatever the failure path goes on to do with it. That is not
  // a hypothetical: written the other way round, this test also passed against a build
  // that threw the source away.
  await expect(page.locator('.figure-error')).toBeVisible();

  // A broken graph is when a reviewer most needs to point at the line that broke it.
  await expect(page.locator('.graphviz-block pre.graphviz')).toHaveCount(1);
  await expect(page.locator('.graphviz-block pre.graphviz')).toContainText('digraph { a -> }');
  await expect(page.locator('.graphviz-block svg')).toHaveCount(0);
});

test('puts nothing executable in the document, and the check would notice if it did', async ({
  page,
  akapen,
}) => {
  // A label graphviz passes straight through, and a URL it turns into a link.
  await show(
    page,
    akapen,
    ['```dot', 'digraph { n [label="x", URL="javascript:alert(1)"]; m [label="y"]; n -> m }', '```'].join(
      '\n',
    ),
  );
  await expect(page.locator('.graphviz-block svg')).toBeVisible();

  const live = (selector: string) =>
    page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root) return ['no such element'];
      const found: string[] = [];
      for (const el of root.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          if (/^on/i.test(attr.name)) found.push(`${el.tagName}@${attr.name}`);
          if (/^(href|xlink:href)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) {
            found.push(`${el.tagName}@${attr.name}=javascript:`);
          }
        }
        if (['script', 'foreignobject'].includes(el.tagName.toLowerCase())) found.push(el.tagName);
      }
      return found;
    }, selector);

  expect(await live('.graphviz-block')).toEqual([]);

  // The scan above only knows the shapes it was told to look for, so it would miss an
  // <iframe> or an <object> arriving by some route nobody predicted. What is on the page
  // is therefore also checked against the list of what may be there.
  const elements = await page.evaluate(() =>
    [
      ...new Set(
        [...document.querySelectorAll('.graphviz-block svg, .graphviz-block svg *')].map((e) => e.localName),
      ),
    ].toSorted(),
  );
  const allowed = new Set([
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
  expect(elements.filter((name) => !allowed.has(name))).toEqual([]);

  // The positive control. Without it, the empty result above is indistinguishable from a
  // check that walks nothing — which is the failure this whole test exists to avoid.
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.id = 'sanitizer-probe';
    probe.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg"><text onclick="void 0">t</text>' +
      '<a xlink:href="javascript:void 0">l</a></svg>';
    document.body.append(probe);
  });
  expect(await live('#sanitizer-probe')).toEqual(['text@onclick', 'a@xlink:href=javascript:']);
});

test('repaints the default black-on-white for a dark page', async ({ page, akapen }) => {
  // graphviz paints in absolute colours, so a figure left alone is a white sheet in the
  // middle of a dark document. Only its defaults are remapped, by value, so a graph that
  // names its own colour keeps it.
  await page.emulateMedia({ colorScheme: 'dark' });
  await show(page, akapen, GRAPH);
  await expect(page.locator('.graphviz-block svg')).toBeVisible();

  const ink = 'rgb(230, 237, 243)'; // --ak-fg, dark
  const paper = 'rgb(13, 17, 23)'; // --ak-bg, dark

  const paint = await page.evaluate(() =>
    (
      [
        // The sheet graphviz draws the graph on
        ['sheet', '.graphviz-block svg polygon[fill="white"]'],
        // An arrowhead: a polygon *filled* black, not merely stroked
        ['arrowhead', '.graphviz-block svg polygon[fill="black"]'],
        // A node label, which graphviz gives no fill attribute at all
        ['label', '.graphviz-block svg text:not([fill])'],
        // A value the rules do not name
        ['outline', '.graphviz-block svg ellipse[fill="none"]'],
      ] as const
    ).map(([name, selector]) => {
      const el = document.querySelector(selector);
      return `${name}=${el ? getComputedStyle(el).fill : 'no such element'}`;
    }),
  );

  // One assertion over all four, so a failure names every one that moved rather than the
  // first. The arrowhead and the label were both black against a dark page until the
  // rules covering them existed, and an assertion on the sheet alone said nothing.
  expect(paint).toEqual([`sheet=${paper}`, `arrowhead=${ink}`, `label=${ink}`, 'outline=none']);
});
