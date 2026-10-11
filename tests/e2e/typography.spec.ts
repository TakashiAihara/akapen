/**
 * How the sheet sets its text: prose to the edge of the sheet, and headings that stay
 * distinguishable from it all the way down.
 *
 * Both faults were quiet. Prose stopped at 42em and left a blank strip on the right of the
 * sheet; an h4 was the size of a paragraph and, in a serif, lighter than one. Nothing
 * errors either way, so only the computed styles can say.
 */
import { writeFileSync } from 'node:fs';
import { AUTH, expect, test } from './fixtures.ts';

test.beforeEach(async ({ page, akapen }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(akapen.url);
  await expect(page.locator('.row').first()).toBeVisible();
});

test('lets a long paragraph run to the edge of the sheet', async ({ page }) => {
  const seen = await page.locator('.body p', { hasText: 'One long paragraph' }).evaluate((p) => ({
    p: p.getBoundingClientRect().width,
    body: p.closest('.body')!.getBoundingClientRect().width,
  }));

  expect(seen.p).toBeCloseTo(seen.body, 0);
});

test('keeps every heading level above body text', async ({ page }) => {
  const seen = await page.evaluate(() => {
    // Inline rather than helpers: this body runs in the browser, so nothing can be hoisted out of it
    const [h2, h4, p] = ['.body h2', '.body h4', '.body p'].map((sel) =>
      getComputedStyle(document.querySelector(sel)!),
    );
    // No h3 here: the fixture has none, and adding one would change what the outline lists
    return {
      h2: Number.parseFloat(h2!.fontSize),
      h4: Number.parseFloat(h4!.fontSize),
      p: Number.parseFloat(p!.fontSize),
      h4Weight: Number(h4!.fontWeight),
    };
  });

  expect(seen.h2).toBeGreaterThan(seen.h4);
  expect(seen.h4).toBeGreaterThan(seen.p);
  // 700, not 600: a face with only a regular draws 600 as regular, and the serif h4 then
  // reads lighter than the sans paragraph under it
  expect(seen.h4Weight).toBeGreaterThanOrEqual(700);
});

test('keeps line numbers apart at the frontmatter fences (#90)', async ({ page, akapen, request }) => {
  for (const [source, fences] of [
    ['---\ntitle: x\nstatus: draft\n---\n\n# Heading\n\nPara.\n', 2],
    ['# Heading\n\nPara.\n\nMore.\n', 0],
  ] as const) {
    writeFileSync(akapen.file, source);
    expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
    await page.goto(akapen.url);
    await expect(page.locator('.row.fm-fence')).toHaveCount(fences);
    // Hidden, the fences keep their thin strip: the room is for the number only.
    for (const fence of await page.locator('.row.fm-fence').all()) {
      expect((await fence.boundingBox())!.height).toBeLessThan(8);
    }
    await page.locator('#showLines').check();
    await expect(page.locator('.lineno').first()).toBeVisible();
    const seen = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.lineno')].map((n) => n.getBoundingClientRect());
      const fence = [...document.querySelectorAll('.row.fm-fence')].map(
        (r) => r.getBoundingClientRect().height,
      );
      const para = document.querySelector('.row.paragraph')!.getBoundingClientRect().height;
      return {
        overlaps: boxes.slice(1).filter((b, i) => b.top < boxes[i]!.bottom - 0.5).length,
        // No taller than a line of text needs: the room is the number's, and no more.
        tallest: Math.max(0, ...fence) / para,
      };
    });
    expect(seen.overlaps).toBe(0);
    expect(seen.tallest).toBeLessThan(1.2);
  }
});
