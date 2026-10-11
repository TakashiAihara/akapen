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
  for (const source of [
    '---\ntitle: x\nstatus: draft\n---\n\n# Heading\n\nPara.\n',
    '# Heading\n\nPara.\n\nMore.\n',
  ]) {
    writeFileSync(akapen.file, source);
    expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
    await page.goto(akapen.url);
    await page.evaluate(() => document.body.classList.add('show-lines'));
    await expect(page.locator('.row').first()).toBeVisible();
    const overlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.lineno')].map((n) => n.getBoundingClientRect());
      return boxes.slice(1).filter((b, i) => b.top < boxes[i]!.bottom - 0.5).length;
    });
    expect(overlaps).toBe(0);
  }
});
