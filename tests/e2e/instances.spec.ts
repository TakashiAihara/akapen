/**
 * The switcher: getting from one akapen to another on the same host.
 *
 * The list is built by the server, but everything that makes it usable is in the DOM —
 * the button appearing only when there is somewhere to go, the link being built from
 * the address this page was opened on rather than from what the peer bound, and a peer
 * that cannot be reached being shown without a link instead of with a dead one. None of
 * that is visible from the HTTP payload.
 */
import { expect, startPeer, test } from './fixtures.ts';

const TOGGLE = '#peersToggle';
const PANEL = '#peers';
const ROW = '#peersList .peer';

test.beforeEach(async ({ page, akapen }) => {
  await page.goto(akapen.url);
  await expect(page.locator('.row').first()).toBeVisible();
});

test('stays out of the way while nothing else is running', async ({ page }) => {
  await expect(page.locator(TOGGLE)).toBeHidden();
  await expect(page.locator(PANEL)).toBeHidden();
});

test('lists a peer and links to it through the address this page was opened on', async ({ page, akapen }) => {
  // Bound to 0.0.0.0, as akapen is when it is read from another machine
  const peer = await startPeer(akapen.home, 'design.md', ['--host', '0.0.0.0']);
  try {
    await page.reload();
    await expect(page.locator(TOGGLE)).toHaveText('⇄ 1 other');

    // The keyboard opens it, the same way the mouse does (W-2)
    await page.keyboard.press('o');
    await expect(page.locator(PANEL)).toBeVisible();

    const row = page.locator(ROW);
    await expect(row).toHaveCount(1);
    await expect(row.locator('.peer-round')).toHaveText('R001');
    await expect(row.locator('.peer-unresolved')).toHaveText('0 unresolved');

    const link = row.locator('a.peer-file');
    // The basename, never the path: the switcher is read over the LAN with nothing
    // authenticating a reader, and directory layout is not something to hand out.
    await expect(link).toHaveText('design.md');
    // The hostname comes from this page, not from the peer. `localhost` and `127.0.0.1`
    // would point at the reader's own machine, which is not where akapen is running.
    const { hostname, protocol } = new URL(akapen.url);
    await expect(link).toHaveAttribute('href', `${protocol}//${hostname}:${peer.port}/`);

    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL)).toBeHidden();
  } finally {
    peer.stop();
  }
});

test('shows a peer bound to loopback, but does not link to it', async ({ page, akapen }) => {
  // The default bind. It answers the server sitting next to it and nowhere the reader's
  // browser can reach — worth listing, since it is how you find where it is running.
  const peer = await startPeer(akapen.home, 'scratch.md');
  try {
    await page.reload();
    await page.locator(TOGGLE).click();

    const row = page.locator(ROW);
    await expect(row.locator('.peer-file')).toHaveText('scratch.md');
    await expect(row.locator('a')).toHaveCount(0);
    await expect(row.locator('.peer-unreachable')).toHaveText('not reachable');
  } finally {
    peer.stop();
  }
});

test('drops the row when the peer stops, and takes the button with it', async ({ page, akapen }) => {
  const peer = await startPeer(akapen.home, 'design.md', ['--host', '0.0.0.0']);
  await page.reload();
  await expect(page.locator(TOGGLE)).toBeVisible();

  peer.stop();

  // Refreshed on the way open, so a review that ended is never a row left to click
  await page.locator(TOGGLE).click();
  await expect(page.locator(TOGGLE)).toBeHidden();
  await expect(page.locator(PANEL)).toBeHidden();
});
