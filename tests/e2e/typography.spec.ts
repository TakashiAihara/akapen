/**
 * How the sheet sets its text: prose to the edge of the sheet, and headings that stay
 * distinguishable from it all the way down.
 *
 * Both faults were quiet. Prose stopped at 42em and left a blank strip on the right of the
 * sheet; an h4 was the size of a paragraph and, in a serif, lighter than one. Nothing
 * errors either way, so only the computed styles can say.
 */
import type { APIRequestContext, Page } from '@playwright/test';
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

/**
 * Ink-to-ink gaps between consecutive rows: each row's rendered block, not the row, since
 * the space is what is measured. One fewer than the rows.
 */
async function gapsOf(
  page: Page,
  source: string,
  akapen: { url: string; file: string },
  request: APIRequestContext,
) {
  writeFileSync(akapen.file, source);
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
  await page.goto(akapen.url);
  await expect(page.locator('.row').last()).toBeVisible();
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll('.row > .body > :first-child')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }),
  );
  return boxes.slice(1).map((b, i) => b.top - boxes[i]!.bottom);
}

test('leaves the same space on the way out of a list as on the way in (#92)', async ({
  page,
  akapen,
  request,
}) => {
  const gaps = await gapsOf(page, 'Before.\n\n- one\n- two\n- three\n\nAfter.\n', akapen, request);
  expect(gaps).toHaveLength(4);
  const [into, between, , out] = gaps as [number, number, number, number];
  expect(out).toBeCloseTo(into, 0);
  // And not by spacing every item: inside the list the rows stay tight.
  expect(between).toBeLessThan(into - 3);
});

test('spaces the way out of a list that ends in a code block, and not the way into it', async ({
  page,
  akapen,
  request,
}) => {
  const source = 'Before.\n\n- item\n\n  ```sh\n  make\n  ```\n\nAfter.\n';
  const gaps = await gapsOf(page, source, akapen, request);
  // Before → item, item → fence, fence → code, code → fence, fence → After
  expect(gaps).toHaveLength(5);
  const [into, intoCode, , , out] = gaps as [number, number, number, number, number];
  expect(out).toBeCloseTo(into, 0);
  expect(intoCode).toBeLessThan(into - 3);
});

test('starts the line number and the + level with a heading, not above it (#91, #28)', async ({
  page,
  akapen,
  request,
}) => {
  writeFileSync(
    akapen.file,
    'Para.\n\n## Section\n\n### Right under\n\nPara.\n\n#### Four\n\nPara.\n\n##### Five\n\nPara.\n',
  );
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
  await page.goto(akapen.url);
  await page.evaluate(() => document.body.classList.add('show-lines'));
  await expect(page.locator('.row.heading')).toHaveCount(4);

  // The number's top against the top of the heading's first line of text.
  const offsets = await page.evaluate(() =>
    [...document.querySelectorAll('.row.heading')].map((row) => {
      const range = document.createRange();
      range.selectNodeContents(row.querySelector('.body > *')!);
      return row.querySelector('.lineno')!.getBoundingClientRect().top - range.getClientRects()[0]!.top;
    }),
  );
  // Above it by the heading's own top margin before (16px for an h2); now within a few px.
  // A few px above, from the heading's half-leading: not below, as a centred gutter would be.
  for (const off of offsets) {
    expect(off).toBeLessThanOrEqual(0);
    expect(off).toBeGreaterThan(-8);
  }

  // The space each one opens: a heading right under another opens less, and the first row none.
  // One number used twice: the heading's top margin, and the gutter's top padding.
  const above = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.row.heading')].map((row) => {
        const margin = getComputedStyle(row.querySelector('.body > *')!).marginTop;
        return margin === getComputedStyle(row.querySelector('.gutter')!).paddingTop ? margin : 'apart';
      }),
    );
  expect(await above()).toEqual(['16px', '6px', '10px', '9px']);
  writeFileSync(akapen.file, '## First\n\nPara.\n');
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
  await page.goto(akapen.url);
  await expect(page.locator('.row.heading')).toHaveCount(1);
  expect(await above()).toEqual(['0px']);
});
