/**
 * What a `--css` stylesheet can change, measured with one loaded (#241).
 *
 * Every other spec reads the default sheet only, so a custom sheet written against the
 * variables — and the rules that let it be — could break with nothing failing. The
 * stylesheets are the one in examples/ and a line height far from the default.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, startPeer, test, TOKEN } from './fixtures.ts';

async function served(css: string, source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'akapen-e2e-css-'));
  const file = join(dir, 'note.md');
  writeFileSync(file, source);
  const peer = await startPeer(join(dir, 'home'), file, ['--css', css]);
  return {
    url: `http://127.0.0.1:${peer.port}/?token=${TOKEN}`,
    stop: async () => {
      await peer.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('takes the space above every heading level from examples/dense.css', async ({ page }) => {
  const doc = await served(
    resolve('examples/dense.css'),
    'Para.\n\n# Top\n\nPara.\n\n## Section\n\n### Right under\n\nPara.\n',
  );
  try {
    await page.goto(doc.url);
    await expect(page.locator('.row.heading')).toHaveCount(3);
    // The heading's top margin and the gutter's top padding: one number, used twice.
    const above = await page.evaluate(() =>
      [...document.querySelectorAll('.row.heading')].map((row) => {
        const margin = getComputedStyle(row.querySelector('.body > *')!).marginTop;
        return margin === getComputedStyle(row.querySelector('.gutter')!).paddingTop ? margin : 'apart';
      }),
    );
    // 12px from the sheet, h1 included; the default 6px under another heading still wins.
    expect(above).toEqual(['12px', '12px', '6px']);
  } finally {
    await doc.stop();
  }
});

test('keeps line numbers apart with a line height far from the default', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'akapen-e2e-css-sheet-'));
  const sheet = join(dir, 'tall.css');
  writeFileSync(sheet, ':root { --ak-line-height: 2.2; }\n');
  const doc = await served(sheet, '---\ntitle: x\nstatus: draft\n---\n\n# Heading\n\nPara.\n\nMore.\n');
  try {
    await page.goto(doc.url);
    await page.locator('#showLines').check();
    await expect(page.locator('.lineno').first()).toBeVisible();
    const seen = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.lineno')].map((n) => n.getBoundingClientRect());
      return {
        count: boxes.length,
        overlaps: boxes.slice(1).filter((b, i) => b.top < boxes[i]!.bottom - 0.5).length,
      };
    });
    expect(seen.count).toBeGreaterThan(4);
    expect(seen.overlaps).toBe(0);
  } finally {
    await doc.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
