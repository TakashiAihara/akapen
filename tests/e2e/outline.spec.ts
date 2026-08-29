/**
 * The outline, in a real browser.
 *
 * What the headings are and how they nest is settled without a browser
 * (packages/web/tests/outline.test.ts). What only a browser shows is the rest of it: that
 * the panel opens over the document without moving it, that a row actually lands its
 * heading below the sticky header rather than underneath it, and that opening the panel
 * after scrolling says which section is being read — which is the whole reason a panel
 * can stand in for a column.
 */
import { expect, test } from './fixtures.ts';
import type { Locator, Page } from '@playwright/test';

/**
 * Wait for a jump to arrive.
 *
 * The current section is worked out once, when the panel opens, so opening it mid-glide
 * reads a position nobody is at. Waiting on the heading's own position rather than on a
 * clock: a sleep would be one timer racing another, and comparing the scroll offset
 * between two frames answers "settled" before the animation has even started.
 */
async function jumpLanded(page: Page, heading: Locator): Promise<void> {
  const offset = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ak-jump-offset')),
  );
  // A band around the offset rather than "at or above" it: the looser form is also
  // satisfied by a jump that left the heading at the very top, under the sticky header.
  await expect
    .poll(async () => Math.abs((await heading.evaluate((n) => n.getBoundingClientRect().top)) - offset))
    .toBeLessThanOrEqual(1.5);
}

const TOGGLE = '#outlineToggle';
const PANEL = '#outline';
const ROW = '#outlineList .outline-entry';

test.beforeEach(async ({ page, akapen }) => {
  await page.goto(akapen.url);
  await expect(page.locator('.row').first()).toBeVisible();
});

test('lists the headings in the order the document has them', async ({ page }) => {
  await expect(page.locator(PANEL)).toBeHidden();
  await page.locator(TOGGLE).click();

  await expect(page.locator(PANEL)).toBeVisible();
  await expect(page.locator(ROW)).toHaveText([
    'Heading',
    'What is settled',
    'Table',
    'The last section',
    'Raw HTML',
    'Diagram',
    'Diagram (capitalised fence)',
  ]);
});

/** Where a row's text starts, which is what the indent is. */
const indentOf = (page: Page, text: string) =>
  page
    .locator(ROW)
    .filter({ hasText: text })
    .first()
    .evaluate((n) => Number.parseFloat(getComputedStyle(n).paddingLeft));

test('indents by how deep the heading sits, not by the level it is written at', async ({ page, akapen }) => {
  // A document that skips a level, because that is the only shape the two disagree on.
  // Without one, indenting by the written level and indenting by the depth in the tree
  // draw the same picture, and this would pass either way.
  akapen.append('\n# Appendix\n\n### Skipped to h3\n\nA paragraph.\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');

  await page.locator(TOGGLE).click();
  const top = await indentOf(page, 'Heading');
  const oneStep = await indentOf(page, 'What is settled');
  const appendix = await indentOf(page, 'Appendix');
  const skipped = await indentOf(page, 'Skipped to h3');

  const step = oneStep - top;
  expect(step).toBeGreaterThan(0);
  expect(appendix).toBe(top);
  // One step past the h1 it sits under. By the written level it would be two steps in,
  // leaving room for an h2 the document never had.
  expect(skipped - appendix).toBe(step);
});

test('takes the reader to the heading, and clear of the header that would cover it', async ({ page }) => {
  await page.locator(TOGGLE).click();
  await page.locator(ROW).filter({ hasText: 'The last section' }).click();

  // The panel gets out of the way rather than staying over what was just jumped to
  await expect(page.locator(PANEL)).toBeHidden();

  const heading = page.locator('#doc .row.heading', { hasText: 'The last section' });
  await expect(heading).toBeInViewport();
  const headerBottom = await page.locator('.topbar').evaluate((n) => n.getBoundingClientRect().bottom);
  const headingTop = await heading.evaluate((n) => n.getBoundingClientRect().top);
  expect(headingTop).toBeGreaterThanOrEqual(headerBottom);
});

test('leaves the document where it is: a panel, not a column', async ({ page }) => {
  const before = await page.locator('#doc').evaluate((n) => n.getBoundingClientRect().width);
  await page.locator(TOGGLE).click();
  await expect(page.locator(PANEL)).toBeVisible();
  const after = await page.locator('#doc').evaluate((n) => n.getBoundingClientRect().width);
  expect(after).toBe(before);
});

test.describe('the current section', () => {
  /**
   * A window short enough that a heading can really reach the top of it. At the default
   * size this document does not scroll far enough for a jump to land where it aims, and
   * the test would be measuring the fixture's length rather than the behaviour.
   */
  test.use({ viewport: { width: 1280, height: 400 } });

  test('says which section is being read, worked out at the moment it opens', async ({ page }) => {
    // Jump, then come back in. The heading landed on has to be the one reported, which is
    // what ties the distance a jump leaves under the header to the line this reads.
    await page.locator(TOGGLE).click();
    await page.locator(ROW).filter({ hasText: 'Raw HTML' }).click();
    await jumpLanded(page, page.locator('#doc .row.heading', { hasText: 'Raw HTML' }));
    await page.locator(TOGGLE).click();
    await expect(page.locator(`${ROW}.current`)).toHaveText('Raw HTML');

    // And it is taken again on the next open, rather than being the answer from last time
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.locator(TOGGLE).click();
    await expect(page.locator(`${ROW}.current`)).toHaveText('Heading');
  });
});

test('opens and closes from the keyboard as well as the button', async ({ page }) => {
  await page.keyboard.press('t');
  await expect(page.locator(PANEL)).toBeVisible();
  await page.keyboard.press('t');
  await expect(page.locator(PANEL)).toBeHidden();

  await page.keyboard.press('t');
  await expect(page.locator(PANEL)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeHidden();
});

test('closes when the reader goes back to the document', async ({ page }) => {
  await page.locator(TOGGLE).click();
  await expect(page.locator(PANEL)).toBeVisible();
  // A row the panel is not sitting on top of: it hangs over the start of the document
  await page.locator('#doc .row').last().click();
  await expect(page.locator(PANEL)).toBeHidden();
});

test('escape still cancels a draft once the panel is shut', async ({ page }) => {
  // The panel took Escape first, so this is the check that it gave it back
  await page.locator(TOGGLE).click();
  await page.keyboard.press('Escape');
  await expect(page.locator(PANEL)).toBeHidden();

  await page.locator('#doc .row').last().click();
  await page.keyboard.press('c');
  await expect(page.locator('.bubble.draft')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.bubble.draft')).toHaveCount(0);
});
