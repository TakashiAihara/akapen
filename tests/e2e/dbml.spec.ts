/**
 * A DBML file opened on its own.
 *
 * The premise of the feature: a schema is reviewed where it lives, not pasted into a
 * scratch document first. What a browser has to answer is that the figure is drawn from
 * the file's own text, that the text is not rewritten on the way, and that a schema
 * which does not parse still leaves something to point at.
 */
import { expect, test, TOKEN, startPeer } from './fixtures.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = [
  'Table users {',
  '  id integer [pk]',
  '  status varchar [note: "__pending__ or shipped"]',
  '  team_id integer [ref: > teams.id]',
  '}',
  '',
  'Table teams {',
  '  id integer [pk]',
  '}',
].join('\n');

/** A server for one file of our choosing, since the shared fixture is markdown. */
async function open(page: import('@playwright/test').Page, name: string, content: string) {
  const home = mkdtempSync(join(tmpdir(), 'akapen-e2e-dbml-'));
  const peer = await startPeer(home, name, [], content);
  const url = `http://127.0.0.1:${peer.port}`;
  await page.context().addCookies([{ name: 'akapen_token', value: TOKEN, url }]);
  await page.goto(url);
  return { url, stop: peer.stop };
}

test('draws the schema, from a file akapen was pointed straight at', async ({ page }) => {
  const { url, stop } = await open(page, 'schema.dbml', SCHEMA);
  try {
    const offSite: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith(url)) offSite.push(r.url());
    });

    await expect(page.locator('.dbml-block svg')).toBeVisible();
    const labels = await page.locator('.dbml-block svg text').allTextContents();
    expect(labels.map((t) => t.trim())).toEqual(expect.arrayContaining(['users', 'teams']));

    // One figure over the whole file, so there is one thing to comment on (#82 is what
    // makes it a line).
    await expect(page.locator('.row')).toHaveCount(1);

    // Neither engine came from anywhere but akapen.
    expect(offSite).toEqual([]);
  } finally {
    await stop();
  }
});

test('shows the schema as written, not as markdown would rewrite it', async ({ page }) => {
  const { stop } = await open(page, 'schema.dbml', SCHEMA);
  try {
    await expect(page.locator('.dbml-block svg')).toBeVisible();
    // Read as markdown, `__pending__` arrives as <strong>pending</strong> and the
    // document under review stops being the document on disk. This is the whole reason
    // a file of this kind does not go through markdown-it.
    await expect(page.locator('.dbml-block strong')).toHaveCount(0);
    // The figure does not draw column notes, so the source itself is what has to be
    // checked — as the browser received it, rather than as the parser produced it.
    const html = await page.evaluate(async () => {
      const payload = (await (await fetch('/api/doc')).json()) as { doc: { blocks: { html: string }[] } };
      return payload.doc.blocks.map((b) => b.html).join('');
    });
    expect(html).not.toContain('<strong>');
    expect(html).toContain('__pending__');
  } finally {
    await stop();
  }
});

test('leaves something to point at when the schema does not parse', async ({ page }) => {
  const { stop } = await open(page, 'broken.dbml', 'Table users {\n  id integer [pk\n');
  try {
    // The parser's own message, not merely some message. Any failure at all — a missing
    // asset, a bundle that did not load — puts a box on the screen too, and asserting
    // only that one appeared would pass without the parser ever having run.
    await expect(page.locator('.figure-error')).toContainText(/line \d+/);

    await expect(page.locator('.dbml-block pre.dbml')).toContainText('Table users {');
    await expect(page.locator('.dbml-block svg')).toHaveCount(0);
  } finally {
    await stop();
  }
});
