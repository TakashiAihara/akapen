/**
 * Copying a fenced block (#168): the code without its fences, every line of it.
 *
 * akapen is read over plain http from another machine, where the page is not a secure
 * context and the clipboard API does not exist. That is the path tested here: the page is
 * told it is not secure, and what the copy command would put on the clipboard is caught.
 */
import { writeFileSync } from 'node:fs';
import { AUTH, expect, test } from './fixtures.ts';

const SOURCE = [
  '# Code',
  '',
  '```bash',
  'set -euo pipefail',
  '',
  'for f in a b c; do',
  '  echo "$f"',
  'done',
  '```',
  '',
  '- inside a list:',
  '',
  '  ```sh',
  '  make test',
  '  ```',
  '',
].join('\n');

test.beforeEach(async ({ page, akapen, request }) => {
  writeFileSync(akapen.file, SOURCE);
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { value: false });
    // Only the copy command puts anything on the clipboard; any other leaves it untouched.
    document.execCommand = (command: string) => {
      if (command !== 'copy') return false;
      (window as unknown as { copied: string }).copied = (
        document.activeElement as HTMLTextAreaElement
      ).value;
      return true;
    };
  });
  await page.goto(akapen.url);
  await expect(page.locator('.row.code-first')).toHaveCount(2);
});

const copied = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { copied?: string }).copied);

test('copies every line of the block and neither fence', async ({ page }) => {
  const first = page.locator('.row.code-first').first();
  await first.hover();
  await first.locator('.copy-code').click();
  await expect(first.locator('.copy-code')).toHaveText('copied');
  expect(await copied(page)).toBe('set -euo pipefail\n\nfor f in a b c; do\n  echo "$f"\ndone');
});

test('copies a block inside a list without the list indent', async ({ page }) => {
  const second = page.locator('.row.code-first').nth(1);
  await second.hover();
  await second.locator('.copy-code').click();
  expect(await copied(page)).toBe('make test');
});

test('leaves the button out of a selection dragged across the block', async ({ page }) => {
  const text = await page.evaluate(() => {
    const first = document.querySelector('.row.code-first')!;
    const last = document.querySelector('.row.code-last')!;
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    return getSelection()!.toString();
  });
  expect(text).toContain('set -euo pipefail');
  expect(text).not.toContain('copy');
});

test('stops a fence left open at the end of its content, not at the next code block', async ({
  page,
  akapen,
  request,
}) => {
  // The quote ends the fence without a closing line; the indented block after it is another one.
  writeFileSync(akapen.file, '> ```sh\n> echo q\n\n    indented\n');
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
  await page.goto(akapen.url);
  const first = page.locator('.row.code-first');
  await expect(first).toHaveCount(1);
  await first.hover();
  await first.locator('.copy-code').click();
  expect(await copied(page)).toBe('echo q');
});

test('copies a line holding only a non-breaking space as it is, and an empty line as empty', async ({
  page,
  akapen,
  request,
}) => {
  writeFileSync(akapen.file, '```\na\n\n\u00a0\nb\n```\n');
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
  await page.goto(akapen.url);
  const first = page.locator('.row.code-first');
  await expect(first).toHaveCount(1);
  await first.hover();
  await first.locator('.copy-code').click();
  await expect(first.locator('.copy-code')).toHaveText('copied');
  expect(await copied(page)).toBe('a\n\n\u00a0\nb');
});

test('draws an empty line inside a multi-line string as tall as any other empty code line', async ({
  page,
  akapen,
  request,
}) => {
  // Line 3 is empty inside the template string, line 5 is empty outside it.
  writeFileSync(akapen.file, '```js\nconst s = `a\n\nb`;\n\nx\n```\n');
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
  await page.goto(akapen.url);
  await expect(page.locator('.row.code')).toHaveCount(7);
  const height = (line: number) =>
    page
      .locator(`.row.code[data-start="${line}"] .code-line`)
      .evaluate((node) => node.getBoundingClientRect().height);
  const ordinary = await height(5);
  expect(ordinary).toBeGreaterThan(0);
  expect(await height(3)).toBe(ordinary);
});

test('stops a fence left open where an indented block follows on the very next line', async ({
  page,
  akapen,
  request,
}) => {
  // No blank line between them, so the line numbers run on from one block into the other.
  writeFileSync(akapen.file, '> ```sh\n> echo q\n    indented\n');
  expect((await request.post(`${akapen.url}/api/rounds`, { headers: AUTH })).ok()).toBe(true);
  await page.goto(akapen.url);
  await expect(page.locator('.row.code')).toHaveCount(3);
  const first = page.locator('.row.code-first');
  await expect(first).toHaveCount(1);
  await first.hover();
  await first.locator('.copy-code').click();
  await expect(first.locator('.copy-code')).toHaveText('copied');
  expect(await copied(page)).toBe('echo q');
});

test('gives focus back to the button after copying', async ({ page }) => {
  const button = page.locator('.row.code-first').first().locator('.copy-code');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveText('copied');
  await expect(button).toBeFocused();
});
