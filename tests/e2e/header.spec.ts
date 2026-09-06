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
    const seen = await page.evaluate(() => {
      const de = document.documentElement;
      const bar = document.querySelector('.topbar') as HTMLElement;
      const items = [...bar.children].filter(
        (el): el is HTMLElement => el instanceof HTMLElement && !el.hidden && el.offsetParent !== null,
      );
      return {
        scrolled: de.scrollWidth - de.clientWidth,
        // What `overflow-x: clip` would hide: an item placed past the right edge
        past: items
          .filter((el) => Math.round(el.getBoundingClientRect().right) > de.clientWidth)
          .map((el) => el.className || el.tagName.toLowerCase()),
      };
    });

    // The page does not scroll sideways...
    expect(seen.scrolled).toBe(0);
    // ...and that is because everything is inside the window, not because `overflow-x:
    // clip` hid it. The clip makes the first assertion hold on its own even while items
    // sit past the right edge, so this is the one that pins the fix.
    expect(seen.past).toEqual([]);
  });

  test(`tells the banner where the bar ends at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    // Polled, not read once: the observer runs after the resize, so a single read can
    // catch the value from the previous width
    await expect
      .poll(() =>
        page.evaluate(() => {
          const bar = Math.round(document.querySelector('.topbar')!.getBoundingClientRect().height);
          const offset = Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--ak-topbar-h'),
          );
          return offset - bar;
        }),
      )
      .toBe(0);
  });
}

test('keeps the jump offset clear of the bar, as a number the outline can read', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  // Polled for the same reason as the offset above: the observer runs after the resize
  await expect
    .poll(() =>
      page.evaluate(() => {
        const bar = Math.round(document.querySelector('.topbar')!.getBoundingClientRect().height);
        // parseFloat is how app.ts reads it. A calc() would arrive here as a string and be 0
        const jump = Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--ak-jump-offset'),
        );
        return Number.isNaN(jump) ? null : jump > bar;
      }),
    )
    .toBe(true);
});

test('shortens the path rather than the bar, and keeps the whole of it reachable', async ({
  page,
  akapen,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const file = page.locator('#filePath');
  // One line, whatever its length. This is the fault #93 opened on: an absolute path
  // wrapped to seven lines and ate a third of the screen before the document began
  const lines = await file.evaluate((el) => {
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
    return Math.round(el.getBoundingClientRect().height / line);
  });
  expect(lines).toBe(1);
  // Shortened on screen, so the whole of it has to live somewhere: the bar is the only
  // thing naming the document being read
  await expect(file).toHaveAttribute('title', akapen.file);
});
