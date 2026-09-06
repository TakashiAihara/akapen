/**
 * The bar stays one line, and what sits under it knows how tall it is.
 *
 * Three faults, all of them quiet. The bar is a flex row that never wrapped, so on a
 * narrow screen it ran off the edge and took the page's horizontal scroll with it — 357px
 * of it at 320px wide. The banner's resting place and the distance a jumped-to heading
 * lands from the top were both written against a 41px bar, and the bar is more than twice
 * that when the window is small; the banner covered the first line and a heading reached
 * from the outline landed underneath the bar.
 *
 * None of it errors, and none of it is visible on a desktop window, which is where it was
 * written and where it was read.
 *
 * The widths are the four the mobile floor names, plus the desktop one for a control.
 */
import { expect, test } from './fixtures.ts';

const WIDTHS = [320, 375, 414, 768, 1440] as const;

test.beforeEach(async ({ page, akapen }) => {
  await page.goto(akapen.url);
  await expect(page.locator('.row').first()).toBeVisible();
});

for (const width of WIDTHS) {
  test(`stays inside the window at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBe(0);
  });

  test(`tells the banner where the bar ends at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const { barHeight, offset } = await page.evaluate(() => ({
      barHeight: Math.round(document.querySelector('.topbar')!.getBoundingClientRect().height),
      offset: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ak-topbar-h')),
    }));
    expect(offset).toBe(barHeight);
  });
}

test('keeps the jump offset clear of the bar, as a number the outline can read', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const { barHeight, jump } = await page.evaluate(() => ({
    barHeight: Math.round(document.querySelector('.topbar')!.getBoundingClientRect().height),
    // parseFloat is how app.ts reads it. A calc() would arrive here as a string and be 0
    jump: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ak-jump-offset')),
  }));
  expect(Number.isNaN(jump)).toBe(false);
  expect(jump).toBeGreaterThan(barHeight);
});

test('shortens the path rather than the bar, and keeps the whole of it reachable', async ({
  page,
  akapen,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const file = page.locator('#filePath');
  // Truncated on screen...
  const clipped = await file.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(clipped).toBe(true);
  // ...but not lost: the bar is the only thing naming the document being read
  await expect(file).toHaveAttribute('title', akapen.file);
});
