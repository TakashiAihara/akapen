/**
 * Images beside the document appear in the preview (#81).
 *
 * The failure this replaces was quiet in the way that matters: markdown-it wrote a
 * correct `<img>`, the request 404'd, and the writer saw a broken image with nothing
 * saying akapen was the reason. Only a browser that decodes the image can say it shows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AUTH, expect, test } from './fixtures.ts';

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

test('enlarges an image or a diagram on click, and closes on the next click or Escape', async ({
  page,
  akapen,
  request,
}) => {
  writeFileSync(join(dirname(akapen.file), 'dot.png'), PNG);
  writeFileSync(akapen.file, '# Zoom\n\n![dot](dot.png)\n\n```mermaid\ngraph LR\n  A --> B\n```\n');
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(akapen.url);
  const zoom = page.locator('#zoom');

  await page.locator('.body img[alt="dot"]').click();
  await expect(zoom).toBeVisible();
  // Filling the window is the point; a copy at its original 1px would pass "visible"
  expect((await zoom.locator('img').boundingBox())!.width).toBeGreaterThan(1000);
  await zoom.click();
  await expect(zoom).toBeHidden();

  const diagram = page.locator('.mermaid-block svg');
  await expect(diagram).toBeVisible({ timeout: 15_000 });
  // The label is HTML inside a foreignObject, the likeliest thing a click lands on
  await diagram.locator('.nodeLabel').first().click();
  await expect(zoom.locator('svg')).toBeVisible();
  expect((await zoom.locator('svg').boundingBox())!.width).toBeGreaterThan(
    (await diagram.boundingBox())!.width,
  );
  // Escape closes the overlay and nothing else: no draft opened behind it
  await page.keyboard.press('Escape');
  await expect(zoom).toBeHidden();
  await expect(diagram).toHaveCount(1);
});
