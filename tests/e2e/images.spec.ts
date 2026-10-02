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

test('shows a clicked image at its own size, and leaves a linked image to its link', async ({
  page,
  akapen,
  request,
}) => {
  const dir = dirname(akapen.file);
  writeFileSync(
    join(dir, 'box.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#36c"/></svg>',
  );
  writeFileSync(akapen.file, '# Zoom\n\n![box](box.svg)\n\n[![linked](box.svg)](#elsewhere)\n');
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(akapen.url);
  const zoom = page.locator('#zoom');

  await page.locator('.body img[alt="box"]').click();
  const copy = zoom.locator('img');
  await expect(copy).toBeVisible();
  // Decoded, and neither shrunk nor blown up to the window
  expect(await copy.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(300);
  expect((await copy.boundingBox())!.width).toBe(300);
  await zoom.click();
  await expect(zoom).toBeHidden();
  await expect(zoom.locator('*')).toHaveCount(0);

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
  writeFileSync(akapen.file, `# Zoom\n\nintro\n\n\`\`\`mermaid\ngraph LR\n${chain}\n\`\`\`\n`);
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
  expect((await copy.boundingBox())!.width).toBeGreaterThan(2 * (await diagram.boundingBox())!.width);

  await page.keyboard.press('Escape');
  await expect(zoom).toBeHidden();
  await expect(page.locator('.bubble.draft textarea')).toHaveValue('keep me');
  await expect(page.locator('.row:has(.mermaid-block)')).not.toHaveClass(/focused|in-range/);
});
