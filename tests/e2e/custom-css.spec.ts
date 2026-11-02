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
import type { Page } from '@playwright/test';
import { expect, startPeer, test, TOKEN } from './fixtures.ts';

/** Serve `source` with the sheet `css` writes into the sandbox, then open it. */
async function open(page: Page, css: (dir: string) => string, source: string, run: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'akapen-e2e-css-'));
  try {
    const file = join(dir, 'note.md');
    writeFileSync(file, source);
    const peer = await startPeer(join(dir, 'home'), file, ['--css', css(dir)]);
    try {
      await page.goto(`http://127.0.0.1:${peer.port}/?token=${TOKEN}`);
      await run();
    } finally {
      await peer.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('takes the space above h1, h2 and h4 to h6 from examples/dense.css', async ({ page }) => {
  await open(
    page,
    () => resolve('examples/dense.css'),
    'Para.\n\n# Top\n\nPara.\n\n## Section\n\n### Right under\n\nPara.\n\n### Three\n\nPara.\n\n' +
      '#### Four\n\nPara.\n\n##### Five\n\nPara.\n\n###### Six\n\nPara.\n',
    async () => {
      await expect(page.locator('.row.heading')).toHaveCount(7);
      // The heading's top margin and the gutter's top padding: one number, used twice.
      const above = await page.evaluate(() =>
        [...document.querySelectorAll('.row.heading')].map((row) => [
          getComputedStyle(row.querySelector('.body > *')!).marginTop,
          getComputedStyle(row.querySelector('.gutter')!).paddingTop,
        ]),
      );
      // 12px from the sheet, h1 included; the default 6px under another heading still wins.
      // h3 to h6 each after a paragraph: the default sheet gives h4 10px and h5 and h6 9px,
      // so those three show the sheet took. An h3 is 12px either way.
      expect(above).toEqual([
        ['12px', '12px'],
        ['12px', '12px'],
        ['6px', '6px'],
        ['12px', '12px'],
        ['12px', '12px'],
        ['12px', '12px'],
        ['12px', '12px'],
      ]);
    },
  );
});

test('keeps line numbers apart with a line height far from the default', async ({ page }) => {
  await open(
    page,
    (dir) => {
      writeFileSync(join(dir, 'tall.css'), ':root { --ak-line-height: 2.2; }\n');
      return join(dir, 'tall.css');
    },
    '---\ntitle: x\nstatus: draft\n---\n\n# Heading\n\nPara.\n\nMore.\n',
    async () => {
      await page.locator('#showLines').check();
      await expect(page.locator('.lineno').first()).toBeVisible();
      const seen = await page.evaluate(() => {
        const para = getComputedStyle(document.querySelector('.row.paragraph .body > *')!);
        const boxes = [...document.querySelectorAll('.lineno')].map((n) => n.getBoundingClientRect());
        return {
          // The sheet took: at the default height a number fits even a fixed-height fence.
          ratio: parseFloat(para.lineHeight) / parseFloat(para.fontSize),
          count: boxes.length,
          overlaps: boxes.slice(1).filter((b, i) => b.top < boxes[i]!.bottom - 0.5).length,
        };
      });
      expect(seen.ratio).toBeCloseTo(2.2, 1);
      expect(seen.count).toBeGreaterThan(4);
      expect(seen.overlaps).toBe(0);
    },
  );
});
