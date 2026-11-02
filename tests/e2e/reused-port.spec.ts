/**
 * A port handed to another akapen while a tab is still open on it (#177).
 *
 * The event stream reconnects to whatever now listens there, so the tab kept drawing the
 * old document with nothing saying the port serves another one.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH, expect, startPeer, test } from './fixtures.ts';

test('says when the port serves another document, stops writing to it, and stops saying so when it comes back', async ({
  page,
  akapen,
  context,
  request,
}) => {
  test.setTimeout(90_000);
  // A file of the test's own, so the same document can be started again on the port.
  const dir = mkdtempSync(join(tmpdir(), 'akapen-e2e-reuse-'));
  const mine = join(dir, 'first.md');
  writeFileSync(mine, readFileSync(akapen.file, 'utf8'));
  let first: Awaited<ReturnType<typeof startPeer>> | undefined;
  try {
    first = await startPeer(akapen.home, mine);
    const url = `http://127.0.0.1:${first.port}`;
    await context.addCookies([{ name: 'akapen_token', value: akapen.token, url }]);
    // A comment to act on once the port serves another document.
    const posted = await request.post(`${url}/api/comments`, {
      headers: AUTH,
      data: { startLine: 3, endLine: 3, body: 'a remark' },
    });
    expect(posted.ok()).toBe(true);
    await page.goto(url);
    await expect(page.locator('#filePath')).toContainText('first.md');
    await expect(page.locator('#railAnchored .bubble')).toHaveCount(1);
    await expect(page.locator('#otherDocBar')).toBeHidden();

    await first.stop();
    // While nothing answers, writes are held back, so the screen says why.
    await expect(page.locator('#otherDocText')).toContainText('reconnecting', { timeout: 15_000 });
    const other = join(dir, 'second.md');
    writeFileSync(other, '# Second\n\nAnother document.\n');
    const second = await startPeer(akapen.home, other, { reuse: first.port });
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
      // The same from the screen: resolving is refused, and the bubble says why.
      const bubble = page.locator('#railAnchored .bubble').first();
      await bubble.getByRole('button', { name: 'Resolve' }).click();
      await expect(bubble.locator('.bubble-error')).toContainText('another document');
      await expect(bubble.getByRole('button', { name: 'Resolve' })).toBeEnabled();
      // Nor read from it: the round picker and history would swap the other one in.
      const read = await page.evaluate(() =>
        fetch('/api/doc').then(
          () => 'read',
          (err: Error) => err.message,
        ),
      );
      expect(read).toContain('another document');
      // Its edits are not this tab's: no "the document changed" banner for them.
      appendFileSync(other, '\nMore.\n');
      await page.waitForTimeout(2_000);
      await expect(page.locator('#banner')).toBeHidden();
    } finally {
      await second.stop();
    }

    // The same document back on the port: the bar goes.
    const again = await startPeer(akapen.home, mine, { reuse: first.port });
    try {
      await expect(page.locator('#otherDocBar')).toBeHidden({ timeout: 25_000 });
    } finally {
      await again.stop();
    }
  } finally {
    // Stopping twice is a no-op, so this only matters when a step above threw first.
    await first?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('says the connection is lost when the port answers to another token, and stops writing to it', async ({
  page,
  akapen,
  context,
  request,
}) => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(join(tmpdir(), 'akapen-e2e-reuse-'));
  const mine = join(dir, 'first.md');
  writeFileSync(mine, readFileSync(akapen.file, 'utf8'));
  let first: Awaited<ReturnType<typeof startPeer>> | undefined;
  try {
    first = await startPeer(akapen.home, mine);
    const url = `http://127.0.0.1:${first.port}`;
    await context.addCookies([{ name: 'akapen_token', value: akapen.token, url }]);
    const posted = await request.post(`${url}/api/comments`, {
      headers: AUTH,
      data: { startLine: 3, endLine: 3, body: 'a remark' },
    });
    expect(posted.ok()).toBe(true);
    await page.goto(url);
    await expect(page.locator('#filePath')).toContainText('first.md');
    await expect(page.locator('#railAnchored .bubble')).toHaveCount(1);
    await expect(page.locator('#otherDocBar')).toBeHidden();

    await first.stop();
    await expect(page.locator('#otherDocText')).toContainText('reconnecting', { timeout: 15_000 });
    // This tab's cookie does not open it, so the stream gets a 401 and the browser gives
    // up: no reconnect will come to say anything else.
    const locked = await startPeer(akapen.home, mine, {
      reuse: first.port,
      token: 'a-token-this-tab-does-not-hold',
    });
    try {
      await expect(page.locator('#otherDocText')).toContainText('lost the connection', { timeout: 25_000 });
      await expect(page.locator('#otherDocBar')).toBeVisible();
      // Not knowing whose akapen answers, the screen writes nothing to it.
      const bubble = page.locator('#railAnchored .bubble').first();
      await bubble.getByRole('button', { name: 'Resolve' }).click();
      await expect(bubble.locator('.bubble-head ~ .bubble-error')).toContainText('another document');
      await bubble.hover();
      await bubble.locator('.reply-input').fill('not for that akapen');
      await bubble.locator('.reply-send').click();
      const said = bubble.locator('.reply-form .bubble-error');
      await expect(said).toContainText('reply failed');
      await expect(said).toContainText('another document');
      // Kept, so the words are not lost.
      await expect(bubble.locator('.reply-input')).toHaveValue('not for that akapen');
    } finally {
      await locked.stop();
    }
  } finally {
    await first?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
