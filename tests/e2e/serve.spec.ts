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

type Served = { add: (file: string) => string; sandbox: string };

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
      await use({ add, sandbox });
    } finally {
      const exited = new Promise<void>((done) => proc.once('exit', () => done()));
      proc.kill();
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

  await request.post(`${urlB}api/comments`, {
    headers: AUTH,
    data: { startLine: 3, endLine: 3, body: 'only on B' },
  });

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
