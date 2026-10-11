/**
 * A port handed to another akapen while a tab is still open on it (#177).
 *
 * The event stream reconnects to whatever now listens there, so the tab kept drawing the
 * old document with nothing saying the port serves another one.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, startPeer, test } from './fixtures.ts';

test('says when the port serves another document, stops writing to it, and stops saying so when it comes back', async ({
  page,
  akapen,
  context,
}) => {
  test.setTimeout(90_000);
  // A file of the test's own, so the same document can be started again on the port.
  const dir = mkdtempSync(join(tmpdir(), 'akapen-e2e-reuse-'));
  const mine = join(dir, 'first.md');
  writeFileSync(mine, readFileSync(akapen.file, 'utf8'));
  try {
    const first = await startPeer(akapen.home, mine);
    const url = `http://127.0.0.1:${first.port}`;
    await context.addCookies([{ name: 'akapen_token', value: akapen.token, url }]);
    await page.goto(url);
    await expect(page.locator('#filePath')).toContainText('first.md');
    await expect(page.locator('#otherDocBar')).toBeHidden();

    await first.stop();
    const second = await startPeer(akapen.home, 'second.md', [], first.port);
    try {
      await expect(page.locator('#otherDocBar')).toBeVisible({ timeout: 25_000 });
      await expect(page.locator('#otherDocText')).toContainText('second.md');
      // Not swapped in: the old document stays until the reader asks.
      await expect(page.locator('#filePath')).toContainText('first.md');
      // And nothing written from this screen reaches the other document.
      const refused = await page.evaluate(() =>
        fetch('/api/rounds', { method: 'POST' }).then(
          () => 'sent',
          (err: Error) => err.message,
        ),
      );
      expect(refused).toContain('another document');
    } finally {
      await second.stop();
    }

    // The same document back on the port: the bar goes.
    const again = await startPeer(akapen.home, mine, [], first.port);
    try {
      await expect(page.locator('#otherDocBar')).toBeHidden({ timeout: 25_000 });
    } finally {
      await again.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
