/**
 * Images beside the document appear in the preview (#81).
 *
 * The failure this replaces was quiet in the way that matters: markdown-it wrote a
 * correct `<img>`, the request 404'd, and the writer saw a broken image with nothing
 * saying akapen was the reason. Only a browser that decodes the image can say it shows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Locator } from '@playwright/test';
import { AUTH, expect, startPeer, test } from './fixtures.ts';

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('shows a relative PNG and SVG, and fits a wide one to the sheet', async ({ page, akapen, request }) => {
  const dir = dirname(akapen.file);
  mkdirSync(join(dir, 'png'));
  writeFileSync(join(dir, 'png', 'dot.png'), PNG);
  writeFileSync(
    join(dir, 'wide.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="100"><rect width="4000" height="100" fill="#c33"/></svg>',
  );
  writeFileSync(akapen.file, '# Images\n\n![dot](png/dot.png)\n\n![wide](wide.svg)\n');
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(akapen.url);

  const dot = page.locator('.body img[alt="dot"]');
  const wide = page.locator('.body img[alt="wide"]');
  await expect(dot).toBeVisible();
  await expect.poll(() => dot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect.poll(() => wide.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(4000);

  const fit = await wide.evaluate((img) => ({
    img: img.getBoundingClientRect().width,
    body: img.closest('.body')!.getBoundingClientRect().width,
  }));
  expect(fit.img).toBeLessThanOrEqual(fit.body);
});

test('shows a clicked image whole without enlarging it, and leaves a linked image to its link', async ({
  page,
  akapen,
  request,
}) => {
  const dir = dirname(akapen.file);
  writeFileSync(
    join(dir, 'box.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#36c"/></svg>',
  );
  writeFileSync(
    join(dir, 'huge.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="100"><rect width="4000" height="100" fill="#c33"/></svg>',
  );
  // Shrunk to the sheet's width and still taller than the window
  writeFileSync(
    join(dir, 'tall.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="8000"><rect width="1200" height="8000" fill="#3a3"/></svg>',
  );
  // At its own size on the sheet, but taller than the window, so it cannot be seen whole
  writeFileSync(
    join(dir, 'narrow.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="4000"><rect width="300" height="4000" fill="#39a"/></svg>',
  );
  // Only a viewBox: Chromium gives it no size of its own beyond 300px wide at its ratio
  writeFileSync(
    join(dir, 'viewbox.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200"><rect width="800" height="200" fill="#c63"/></svg>',
  );
  // Four columns keep each cell narrower than 300px, so the images in them are shrunk
  writeFileSync(
    akapen.file,
    '# Zoom\n\n| a | b | c | d |\n| --- | --- | --- | --- |\n| ![box](box.svg) | ![viewbox](viewbox.svg) | c | d |\n\n![huge](huge.svg)\n\n![tall](tall.svg)\n\n![narrow](narrow.svg)\n\n[![linked](huge.svg)](#elsewhere)\n',
  );
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(akapen.url);
  const zoom = page.locator('#zoom');

  // Decoded, and neither shrunk nor blown up to the window: at its own size, which for an
  // SVG with only a viewBox is what Chromium makes of it
  for (const [alt, w, h] of [
    ['box', 300, 200],
    ['viewbox', 300, 75],
  ] as const) {
    const img = page.locator(`.body img[alt="${alt}"]`);
    await expect(img).toHaveClass(/zoomable/);
    expect((await img.boundingBox())!.width).toBeLessThan(w);
    await img.click();
    const copy = zoom.locator('img');
    await expect(copy).toBeVisible();
    expect(await copy.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([w, h]);
    const shown = (await copy.boundingBox())!;
    expect([Math.round(shown.width), Math.round(shown.height)]).toEqual([w, h]);
    await zoom.click();
    await expect(zoom).toBeHidden();
    await expect(zoom.locator('*')).toHaveCount(0);
  }

  // One wider, or taller, than the window is fitted inside its content box, whole
  expect(
    await page
      .locator('.body img[alt="narrow"]')
      .evaluate((i: HTMLImageElement) => [i.naturalWidth, i.clientWidth]),
  ).toEqual([300, 300]);
  for (const alt of ['huge', 'tall', 'narrow']) {
    await page.locator(`.body img[alt="${alt}"]`).click();
    const fit = await zoom.evaluate((d) => {
      const pad = parseFloat(getComputedStyle(d).paddingLeft);
      const img = d.querySelector('img')!.getBoundingClientRect();
      return { w: img.width, h: img.height, roomW: d.clientWidth - 2 * pad, roomH: d.clientHeight - 2 * pad };
    });
    expect(fit.w).toBeLessThanOrEqual(fit.roomW + 0.5);
    expect(fit.h).toBeLessThanOrEqual(fit.roomH + 0.5);
    expect(Math.max(fit.w / fit.roomW, fit.h / fit.roomH)).toBeGreaterThan(0.99);
    await page.keyboard.press('Escape');
    await expect(zoom).toBeHidden();
  }

  await page.locator('.body img[alt="linked"]').click();
  await expect(page).toHaveURL(/#elsewhere$/);
  await expect(zoom).toBeHidden();
});

test('shows a wide diagram larger than the sheet, without touching the selection or a draft', async ({
  page,
  akapen,
  request,
}) => {
  const chain = Array.from({ length: 20 }, (_, i) => `  N${i}[node ${i}] --> N${i + 1}[node ${i + 1}]`).join(
    '\n',
  );
  writeFileSync(
    akapen.file,
    `# Zoom\n\nintro\n\n\`\`\`mermaid\ngraph LR\n${chain}\n  click N20 "#node-link"\n\`\`\`\n`,
  );
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(akapen.url);
  const zoom = page.locator('#zoom');
  const diagram = page.locator('.mermaid-block svg');
  await expect(diagram).toBeVisible({ timeout: 15_000 });

  // A draft on another row, which Escape on the overlay must not cancel
  const intro = page.locator('.row', { hasText: 'intro' });
  await intro.hover();
  await intro.locator('.add').click();
  await page.locator('.bubble.draft textarea').fill('keep me');

  // The shape, not its label: the click lands on an SVG element, not an HTMLElement
  await diagram
    .locator('g.node rect')
    .first()
    .click({ position: { x: 2, y: 2 } });
  const copy = zoom.locator('svg');
  await expect(copy).toBeVisible();
  // Every node came along, and at its own size it is far wider than the sheet allowed
  expect(await copy.locator('g.node').count()).toBe(await diagram.locator('g.node').count());
  const own = await copy.evaluate((svg: SVGSVGElement) => svg.viewBox.baseVal.width);
  expect(own).toBeGreaterThan(2 * (await diagram.boundingBox())!.width);
  expect(Math.round((await copy.boundingBox())!.width)).toBe(Math.round(own));

  // It opens on the start of the figure with focus on itself, not on the link at node 20
  // (showModal would focus that and scroll over to it)
  expect(await zoom.evaluate((d) => [d.scrollLeft, document.activeElement === d])).toEqual([0, true]);

  // It scrolls, and neither end is cut off: the left edge starts inside the overlay and the
  // right edge is reachable by scrolling all the way
  const ends = await zoom.evaluate((d) => {
    const left = d.querySelector('svg')!.getBoundingClientRect().left - d.getBoundingClientRect().left;
    const scrolls = d.scrollWidth > d.clientWidth;
    d.scrollLeft = 1e6;

    const right = d.getBoundingClientRect().right - d.querySelector('svg')!.getBoundingClientRect().right;
    d.scrollLeft = 0;
    return { left, scrolls, right };
  });

  expect(ends.scrolls).toBe(true);
  expect(ends.left).toBeGreaterThanOrEqual(0);
  expect(ends.right).toBeGreaterThanOrEqual(0);

  // A person can scroll it, not only a script
  await zoom.hover();
  await page.mouse.wheel(600, 0);
  await expect.poll(() => zoom.evaluate((d) => d.scrollLeft)).toBeGreaterThan(0);
  await expect(zoom).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(zoom).toBeHidden();
  await expect(page.locator('.bubble.draft textarea')).toHaveValue('keep me');
  await expect(page.locator('.row:has(.mermaid-block)')).not.toHaveClass(/focused|in-range/);

  // A node with a mermaid `click` href is a link, and follows it
  await diagram.locator('a').first().click();
  await expect(page).toHaveURL(/#node-link$/);
  await expect(zoom).toBeHidden();
});

test('opens the figure on the focused line with z, the same way a click does', async ({
  page,
  akapen,
  request,
}) => {
  const dir = dirname(akapen.file);
  writeFileSync(
    join(dir, 'box.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#36c"/></svg>',
  );
  writeFileSync(
    join(dir, 'huge.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="100"><rect width="4000" height="100" fill="#c33"/></svg>',
  );
  writeFileSync(
    akapen.file,
    '# Zoom\n\ntext\n\n![huge](huge.svg)\n\n[![linked](huge.svg)](#elsewhere)\n\n![box](box.svg)\n',
  );
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);

  await page.goto(akapen.url);
  const zoom = page.locator('#zoom');
  await expect(page.locator('.body img[alt="huge"]')).toHaveClass(/zoomable/);

  // On a line with no figure the key does nothing
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect(page.locator('.row.focused')).toContainText('text');
  await page.keyboard.press('z');
  await expect(zoom).toBeHidden();

  await page.keyboard.press('j');
  await expect(page.locator('.row.focused img[alt="huge"]')).toHaveCount(1);
  await page.keyboard.press('z');
  await expect(zoom.locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(zoom).toBeHidden();

  // A linked image is not a figure: z leaves it alone, as a click leaves it to the link
  await page.keyboard.press('j');
  await expect(page.locator('.row.focused img[alt="linked"]')).toHaveCount(1);
  await page.keyboard.press('z');
  await expect(zoom).toBeHidden();

  // Nor is one the sheet shows whole
  await page.keyboard.press('j');
  await expect(page.locator('.row.focused img[alt="box"]')).toHaveCount(1);
  await page.keyboard.press('z');
  await expect(zoom).toBeHidden();
});

/** The pointer the page shows over an element, read without moving the mouse onto it. */
const cursor = (el: Locator) => el.evaluate((e) => getComputedStyle(e).cursor);

test('leaves an image the page shows whole alone, deciding once it loads and again when it or the window is resized', async ({
  page,
  akapen,
  request,
}) => {
  const dir = dirname(akapen.file);
  writeFileSync(
    join(dir, 'box.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#36c"/></svg>',
  );
  writeFileSync(
    join(dir, 'huge.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="100"><rect width="4000" height="100" fill="#c33"/></svg>',
  );
  writeFileSync(
    join(dir, 'fixed.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="100"><rect width="4000" height="100" fill="#93c"/></svg>',
  );
  writeFileSync(
    akapen.file,
    '# Zoom\n\n![box](box.svg)\n\n![huge](huge.svg)\n\n![fixed](fixed.svg)\n\n![gone](gone.svg)\n',
  );
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);

  // They arrive only after the page has drawn them, so none is decided on a size of 0
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/*.svg', async (route) => {
    await held;
    await route.continue();
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(akapen.url);
  const zoom = page.locator('#zoom');
  const box = page.locator('.body img[alt="box"]');
  const huge = page.locator('.body img[alt="huge"]');
  const fixed = page.locator('.body img[alt="fixed"]');
  await expect(fixed).toBeAttached();
  // A stylesheet that fixes its size: loading changes neither the image's size nor the
  // page's, so nothing but the load itself can decide it
  await page.addStyleTag({ content: '.body img[alt="fixed"] { width: 400px; height: 10px; }' });
  expect(await fixed.evaluate((i: HTMLImageElement) => [i.complete, i.clientWidth, i.clientHeight])).toEqual([
    false,
    400,
    10,
  ]);
  release();

  await expect.poll(() => cursor(fixed)).toBe('zoom-in');
  await expect.poll(() => cursor(huge)).toBe('zoom-in');

  // One with no size of its own is never a figure, even when it is taller than the window
  const gone = page.locator('.body img[alt="gone"]');
  await page.addStyleTag({ content: '.body img[alt="gone"] { display: block; height: 2000px; }' });
  await expect
    .poll(() => gone.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.clientHeight]))
    .toEqual([0, 2000]);
  // Past the frame in which a resize is reported, so a wrong decision would be in place
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await cursor(gone)).not.toBe('zoom-in');
  expect(await box.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.clientWidth])).toEqual([300, 300]);
  expect(await cursor(box)).not.toBe('zoom-in');

  // Clicking it is clicking the line it is on, as with any text
  await box.click();
  await expect(zoom).toBeHidden();
  await expect(page.locator('.row:has(img[alt="box"])')).toHaveClass(/\bfocused\b/);

  // A new round draws the page again with new images, which are decided the same way
  await huge.evaluate((i) => i.setAttribute('data-old', ''));
  writeFileSync(akapen.file, '# Zoon\n\n![box](box.svg)\n\n![huge](huge.svg)\n\n![fixed](fixed.svg)\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('.row.heading')).toContainText('Zoon');
  const redrawn = page.locator('.body img[alt="huge"]:not([data-old])');
  await expect(redrawn).toHaveCount(1);
  await expect(redrawn).toHaveClass(/zoomable/);
  await expect(fixed).toHaveClass(/zoomable/);
  await expect(box).not.toHaveClass(/zoomable/);

  // A window lower than the image cannot show it whole, and then it is a figure
  await page.setViewportSize({ width: 1440, height: 150 });
  await expect.poll(() => cursor(box)).toBe('zoom-in');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => cursor(box)).not.toBe('zoom-in');

  // A sheet narrower than the image shrinks it, and then it is a figure
  await page.setViewportSize({ width: 280, height: 900 });
  await expect.poll(() => cursor(box)).toBe('zoom-in');
  await box.click();
  await expect(zoom.locator('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(zoom).toBeHidden();

  // A sheet that cuts only its height or only its width, as a custom stylesheet can,
  // shrinks it all the same. The last one changes only the image's width, so the page
  // stays the same size.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => cursor(box)).not.toBe('zoom-in');
  for (const [w, h] of [
    [300, 100],
    [100, 250],
    [100, 200],
  ]) {
    const sheet = await page.addStyleTag({
      content: `.body img[alt="box"] { width: ${w}px; height: ${h}px; object-fit: contain; }`,
    });
    await expect.poll(() => cursor(box)).toBe('zoom-in');
    expect(await box.evaluate((i: HTMLImageElement) => [i.clientWidth, i.clientHeight])).toEqual([w, h]);
    await sheet.evaluate((s: HTMLStyleElement) => s.remove());
    await expect.poll(() => cursor(box)).not.toBe('zoom-in');
  }
});

test('opens the icon of an architecture diagram as the whole diagram', async ({ page, akapen, request }) => {
  writeFileSync(
    akapen.file,
    '# Zoom\n\n```mermaid\narchitecture-beta\n  group api(cloud)[API]\n  service db(database)[Database] in api\n  service server(server)[Server] in api\n  db:L -- R:server\n```\n',
  );
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(akapen.url);
  const zoom = page.locator('#zoom');
  const diagram = page.locator('pre.mermaid > svg');
  await expect(diagram).toBeVisible({ timeout: 15_000 });
  // Each service's icon is an svg of its own inside the diagram's
  const icons = diagram.locator('svg');
  expect(await icons.count()).toBeGreaterThanOrEqual(2);

  await icons.first().click();
  const copy = zoom.locator(':scope > svg');
  await expect(copy).toBeVisible();
  await expect(copy).toHaveAttribute('aria-roledescription', 'architecture');
  expect(await copy.locator('svg').count()).toBe(await icons.count());
});

test('closes an open panel when a figure opens over it, by a click or by z', async ({
  page,
  akapen,
  request,
}) => {
  const dir = dirname(akapen.file);
  writeFileSync(
    join(dir, 'huge.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="100"><rect width="4000" height="100" fill="#c33"/></svg>',
  );
  writeFileSync(akapen.file, '# Zoom\n\n![huge](huge.svg)\n');
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
  const peer = await startPeer(akapen.home, 'design.md');
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(akapen.url);
    const zoom = page.locator('#zoom');
    const huge = page.locator('.body img[alt="huge"]');
    await expect(huge).toHaveClass(/zoomable/);

    // The image's line, for z
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(page.locator('.row.focused img[alt="huge"]')).toHaveCount(1);

    for (const [toggle, panel] of [
      ['#outlineToggle', '#outline'],
      ['#peersToggle', '#peers'],
    ] as const) {
      for (const open of [() => huge.click(), () => page.keyboard.press('z')]) {
        await page.locator(toggle).click();
        await expect(page.locator(panel)).toBeVisible();
        await open();
        await expect(zoom.locator('img')).toBeVisible();
        await expect(page.locator(panel)).toBeHidden();
        await page.keyboard.press('Escape');
        await expect(zoom).toBeHidden();
      }
    }
  } finally {
    await peer.stop();
  }
});
