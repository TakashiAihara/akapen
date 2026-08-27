/**
 * What the browser tab is called.
 *
 * The derivation is unit-tested, and this is the part it cannot reach: that the string
 * arrives at `document.title` at all. index.html ships the brand as the title, so a
 * render that never sets it looks right on the page and leaves every tab named
 * `akapen` — which is the state this exists to end.
 */
import { expect, test } from './fixtures.ts';

test('names the tab after the document, not the tool', async ({ page, akapen }) => {
  await page.goto(akapen.url);
  await expect(page.locator('.row').first()).toBeVisible();
  // fixture.md opens with `# Heading`, under a frontmatter block with a `title:` of its own.
  await expect(page).toHaveTitle('Heading — akapen');
});
