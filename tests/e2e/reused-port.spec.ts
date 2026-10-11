/**
 * A port handed to another akapen while a tab is still open on it (#177).
 *
 * The event stream reconnects to whatever now listens there, so the tab kept drawing the
 * old document with nothing saying the port serves another one.
 */
import { expect, startPeer, test } from './fixtures.ts';

test('says when the port behind the tab now serves another document', async ({ page, akapen, context }) => {
  const first = await startPeer(akapen.home, 'first.md');
  const url = `http://127.0.0.1:${first.port}`;
  await context.addCookies([{ name: 'akapen_token', value: akapen.token, url }]);
  await page.goto(url);
  await expect(page.locator('#filePath')).toContainText('first.md');
  await expect(page.locator('#otherDocBar')).toBeHidden();

  await first.stop();
  const second = await startPeer(akapen.home, 'second.md', [], first.port);
  try {
    await expect(page.locator('#otherDocBar')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#otherDocText')).toContainText('second.md');
    // Not swapped in: the old document stays until the reader asks.
    await expect(page.locator('#filePath')).toContainText('first.md');
  } finally {
    await second.stop();
  }
});
