/**
 * The credential, in a real browser.
 *
 * The server tests cover what each status code is. What only a browser shows is whether
 * the flow is actually seamless: that one visit to the printed URL is the whole of
 * logging in, that the token does not stay in the address bar afterwards, and that
 * everything the page does after that — including the SSE stream, which cannot carry a
 * header — goes through on the cookie alone.
 *
 * These use a context of their own rather than the shared fixture's, because the fixture
 * seeds the cookie and the thing being tested here is arriving without one.
 */
import { test, expect } from './fixtures.ts';

test('a browser with no cookie is refused, and told how to get in', async ({ akapen, browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const res = await page.goto(akapen.url);
    expect(res?.status()).toBe(401);
    await expect(page.locator('body')).toContainText('akapen token');
    // Nothing of the document reaches a page that was refused.
    await expect(page.locator('#doc .row')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('one visit to the printed URL is the whole of logging in', async ({ akapen, browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${akapen.url}/?token=${akapen.token}`);

    // The redirect has already happened: what is in the address bar is what a person
    // would copy, and it must not be the secret.
    expect(page.url()).not.toContain(akapen.token);
    expect(page.url()).not.toContain('token');
    await expect(page.locator('#doc .row').first()).toBeVisible();

    const cookies = await context.cookies();
    const held = cookies.find((c) => c.name === 'akapen_token');
    expect(held?.value).toBe(akapen.token);
    expect(held?.httpOnly).toBe(true);

    // The bare URL now works, which is the state every later visit and every reload is.
    const again = await page.goto(akapen.url);
    expect(again?.status()).toBe(200);
    await expect(page.locator('#doc .row').first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the cookie carries commenting and the live stream, not just the first page', async ({
  akapen,
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${akapen.url}/?token=${akapen.token}`);

    await expect(page.locator('.row').first()).toBeVisible();

    // A comment is a POST from the page. If the cookie did not cover it, this is where
    // it would show: the row renders and the click does nothing.
    const row = page.locator('.row').nth(1);
    await row.hover();
    await row.locator('.add').click();
    const draft = '#rail .bubble.draft';
    await page.locator(`${draft} textarea`).fill('written with only a cookie');
    await page.locator(`${draft} button.primary`).click();
    await expect(page.locator('#railAnchored .bubble')).toContainText('written with only a cookie');

    // SSE cannot send a header, so the banner arriving at all is the proof that the
    // stream authenticated on the cookie.
    akapen.append('\nAppended while the page is open.\n');
    await expect(page.locator('#banner')).toBeVisible({ timeout: 10_000 });
  } finally {
    await context.close();
  }
});
