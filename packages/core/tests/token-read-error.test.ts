/**
 * A stored management secret that opens and passes its checks, and then cannot be read.
 *
 * Alone in this file because the read is made to fail for the whole module: nothing on a
 * healthy disk fails that way. It must not count as no secret, or the server would write
 * a new one over a file it could not read.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    // By descriptor is how the secret is read; everything else reads by path, as it was.
    readFileSync: (target: unknown, ...rest: unknown[]) => {
      if (typeof target === 'number') throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      return (fs.readFileSync as (...a: unknown[]) => unknown)(target, ...rest);
    },
  };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'akapen-token-read-'));
  process.env['AKAPEN_HOME'] = home;
  delete process.env['AKAPEN_MANAGE_TOKEN'];
});
afterEach(() => {
  delete process.env['AKAPEN_HOME'];
  rmSync(home, { recursive: true, force: true });
});

it('does not take a secret it cannot read for none, and does not write over it', async () => {
  const { ManageTokenError, readManageToken, resolveManageToken } = await import('../src/token.ts');
  const stored = join(home, 'manage-token');
  mkdirSync(home, { recursive: true });
  writeFileSync(stored, 'kept-management-value\n');
  chmodSync(stored, 0o600);
  const said = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(readManageToken()).toBeNull();
    expect(() => resolveManageToken()).toThrow(ManageTokenError);
    expect(() => resolveManageToken()).toThrow('it cannot be read (EIO)');
  } finally {
    said.mockRestore();
  }
  expect(readFileSync(stored, 'utf8')).toBe('kept-management-value\n');
});
