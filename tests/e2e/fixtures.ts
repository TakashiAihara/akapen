/**
 * テストごとに専用のサーバ・専用の md・専用のストアを立てる。
 *
 * akapen は 1 プロセス 1 ファイルで、コメントはストアに溜まる。1 台を共有すると
 * 前のテストのコメントが次のテストに漏れ、件数を見るアサーションが崩れる
 * (実際 8 件溜まって落ちた)。隔離をテスト側の書き方で回避しない。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from '@playwright/test';

const FIXTURE_MD = join(import.meta.dirname, 'fixture.md');

let nextPort = 4400;

export type Akapen = {
  url: string;
  /** live のファイル。エージェントの編集を模す時に使う */
  file: string;
  append: (text: string) => void;
};

export const test = base.extend<{ akapen: Akapen }>({
  akapen: async ({}, use) => {
    const port = nextPort++;
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-e2e-'));
    const file = join(sandbox, 'note.md');
    writeFileSync(file, readFileSync(FIXTURE_MD, 'utf8'));

    const proc: ChildProcess = spawn('bun', ['run', 'src/cli.ts', file, '-p', String(port)], {
      env: { ...process.env, AKAPEN_HOME: join(sandbox, 'home') },
      stdio: 'ignore',
    });

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${url}/api/doc`)).ok) break;
      } catch {
        /* まだ立っていない */
      }
      if (Date.now() > deadline) throw new Error(`akapen が起動しませんでした: ${url}`);
      await new Promise((r) => setTimeout(r, 150));
    }

    await use({
      url,
      file,
      append: (text: string) => writeFileSync(file, readFileSync(file, 'utf8') + text),
    });

    proc.kill();
    rmSync(sandbox, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
