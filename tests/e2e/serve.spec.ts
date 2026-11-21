/**
 * A document served by `akapen serve` under `/d/<id>/` works in a browser as one served
 * at the root does (#305): the page's requests are relative, so each has to land on its
 * own document's routes and nowhere else.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { AUTH, TOKEN } from './fixtures.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

type Served = { add: (file: string) => string; remove: (file: string) => void; sandbox: string };

const test = base.extend<{ served: Served }>({
  served: async ({ context }, use) => {
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-e2e-serve-'));
    const env = {
      ...process.env,
      AKAPEN_HOME: join(sandbox, 'home'),
      AKAPEN_TOKEN: TOKEN,
      CLAUDE_CODE_SESSION_ID: '',
    };
    const proc: ChildProcess = spawn('bun', ['run', 'packages/cli/src/cli.ts', 'serve', '-p', '0'], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Taken before anything can fail, so teardown never waits on an exit that already happened.
    const exited = new Promise<void>((done) => proc.once('exit', () => done()));
    try {
      const port = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`akapen serve did not start: ${out}`)), 20_000);
        proc.stdout?.on('data', (c: Buffer) => {
          out += c.toString();
          const found = /url\s+http:\/\/[^:]+:(\d+)/.exec(out);
          if (found) {
            clearTimeout(timer);
            resolve(found[1]!);
          }
        });
      });
      await context.addCookies([{ name: 'akapen_token', value: TOKEN, url: `http://127.0.0.1:${port}` }]);
      const add = (file: string): string => {
        const r = spawnSync('bun', ['run', 'packages/cli/src/cli.ts', 'add', file], {
          env: { ...env, AKAPEN_PORT: port },
          encoding: 'utf8',
        });
        if (r.status !== 0) throw new Error(r.stderr);
        return /url\s+(\S+)\?token=/.exec(r.stdout)![1]!;
      };
      const remove = (file: string): void => {
        const r = spawnSync('bun', ['run', 'packages/cli/src/cli.ts', 'remove', file], {
          env: { ...env, AKAPEN_PORT: port },
          encoding: 'utf8',
        });
        if (r.status !== 0) throw new Error(r.stderr);
      };
      await use({ add, remove, sandbox });
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill();
      await exited;
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
});

test('reads, comments and follows edits on each document under its own path', async ({
  page,
  request,
  served,
}) => {
  const dirA = join(served.sandbox, 'a');
  const dirB = join(served.sandbox, 'b');
  mkdirSync(join(dirA, 'png'), { recursive: true });
  mkdirSync(dirB);
  writeFileSync(join(dirA, 'png', 'dot.png'), PNG);
  const fileA = join(dirA, 'note.md');
  writeFileSync(fileA, '# Document A\n\n![dot](png/dot.png)\n\nFirst paragraph.\n');
  writeFileSync(join(dirB, 'note.md'), '# Document B\n\nOther text.\n');
  const urlA = served.add(fileA);
  const urlB = served.add(join(dirB, 'note.md'));

  const seeded = await request.post(`${urlB}api/comments`, {
    headers: AUTH,
    data: { startLine: 3, endLine: 3, body: 'only on B' },
  });
  expect(seeded.ok()).toBe(true);

  await page.goto(urlA);
  await expect(page.locator('#doc')).toContainText('First paragraph.');
  await expect(page.locator('#doc')).not.toContainText('Other text.');
  const dot = page.locator('.body img[alt="dot"]');
  await expect.poll(() => dot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(page.locator('#railAnchored .bubble')).toHaveCount(0);

  const row = page.locator('.row').nth(1);
  await row.hover();
  await row.locator('.add').click();
  await page.locator('#rail .bubble.draft textarea').fill('written on A');
  await page.locator('#rail .bubble.draft button.primary').click();
  await expect(page.locator('#rail .bubble.draft')).toHaveCount(0);
  await expect(page.locator('#railAnchored .bubble')).toHaveCount(1);
  const stored = (await (await request.get(`${urlA}api/comments`, { headers: AUTH })).json()) as {
    body: string;
  }[];
  expect(stored.map((c) => c.body)).toEqual(['written on A']);

  writeFileSync(fileA, '# Document A\n\n![dot](png/dot.png)\n\nFirst paragraph.\n\nAdded by the agent.\n');
  await expect(page.locator('#banner')).toBeVisible();
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#doc')).toContainText('Added by the agent.');
});

test('leads from a document back to the list of documents', async ({ page, served }) => {
  const file = join(served.sandbox, 'note.md');
  writeFileSync(file, '# Listed\n\nText.\n');
  const url = served.add(file);

  await page.goto(url);
  await expect(page.locator('#doc')).toContainText('Text.');
  await page.locator('#brand').click();
  await expect(page).toHaveURL(new URL('/', url).href);
  await expect(page.locator('body')).toContainText('note.md');
});

test('says so when the document it shows is removed', async ({ page, served }) => {
  const file = join(served.sandbox, 'note.md');
  writeFileSync(file, '# Removed\n\nText.\n');
  const url = served.add(file);

  await page.goto(url);
  await expect(page.locator('#doc')).toContainText('Text.');
  await expect(page.locator('#otherDocBar')).toBeHidden();
  served.remove(file);
  await expect(page.locator('#otherDocBar')).toBeVisible({ timeout: 15_000 });
  // Lost, or not answering once asked again: either way the reader is told to reload.
  await expect(page.locator('#otherDocText')).toContainText('reload');
});
