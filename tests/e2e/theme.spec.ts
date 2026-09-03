/**
 * Light / dark, and the state in between.
 *
 * The unit tests pin the logic; what they cannot see is whether pressing the button
 * actually repaints the page. That path runs through three places — a click handler, a
 * `data-theme` attribute on the root, and a stylesheet that keys its dark block off
 * `prefers-color-scheme` *guarded* by that attribute. Any one of them can be wrong while
 * the other two look right, and the failure is silent: the page renders, in the wrong
 * theme, and nothing reports it.
 *
 * The case worth the browser is the third state. `auto` has to be the *absence* of the
 * attribute, because the guard is `:root:not([data-theme='light'])`. Spelling the default
 * as `data-theme="auto"` still satisfies that selector, so every unit test would pass and
 * the OS preference would still work — until someone picks light on a dark OS.
 */
import { expect, test } from './fixtures.ts';

const BUTTON = '#themeToggle';
const bg = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.beforeEach(async ({ page, akapen }) => {
  await page.goto(akapen.url);
  await expect(page.locator('.row').first()).toBeVisible();
});

test('starts on auto, with nothing written to the root', async ({ page }) => {
  await expect(page.locator(BUTTON)).toHaveText('auto');
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
});

test('walks auto -> light -> dark and back, repainting each time', async ({ page }) => {
  const auto = await bg(page);

  await page.click(BUTTON);
  await expect(page.locator(BUTTON)).toHaveText('light');
  const light = await bg(page);

  await page.click(BUTTON);
  await expect(page.locator(BUTTON)).toHaveText('dark');
  const dark = await bg(page);

  // The point of the button: the two choices must not paint the same page
  expect(dark).not.toBe(light);

  await page.click(BUTTON);
  await expect(page.locator(BUTTON)).toHaveText('auto');
  expect(await bg(page)).toBe(auto);
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
});

test('keeps the choice across a reload', async ({ page }) => {
  await page.click(BUTTON);
  await page.click(BUTTON);
  const chosen = await bg(page);

  await page.reload();
  await expect(page.locator('.row').first()).toBeVisible();
  await expect(page.locator(BUTTON)).toHaveText('dark');
  expect(await bg(page)).toBe(chosen);
});

test.describe('on a dark OS', () => {
  test.use({ colorScheme: 'dark' });

  test('follows the OS while on auto', async ({ page }) => {
    await expect(page.locator(BUTTON)).toHaveText('auto');
    // Same document, opposite OS: the ground must differ from the light default
    expect(await bg(page)).not.toBe('rgb(255, 255, 255)');
  });

  test('lets a light choice beat the OS', async ({ page }) => {
    const followingOs = await bg(page);
    await page.click(BUTTON);
    await expect(page.locator(BUTTON)).toHaveText('light');
    expect(await bg(page)).not.toBe(followingOs);
  });
});
