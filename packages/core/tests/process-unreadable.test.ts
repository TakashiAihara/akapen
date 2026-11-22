/**
 * Where nothing beside the pid can be read about a process (a /proc that hides other
 * users' processes, no `ps`), a recorded server is judged by its pid alone, as it was
 * before records held more. Alone in this file because the read is made to fail for the
 * whole module. Taking "cannot be read" for "another process" instead would count a
 * running server as gone, and a second one would start beside it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/process.ts', () => ({ processIdentity: () => null }));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'akapen-serve-unreadable-'));
  process.env['AKAPEN_HOME'] = home;
});
afterEach(() => {
  delete process.env['AKAPEN_HOME'];
  rmSync(home, { recursive: true, force: true });
});

it('counts a recorded server whose pid lives as running when its process cannot be told apart', async () => {
  const { holdsHome, recordedServerAlive, writeServePort } = await import('../src/documents.ts');
  writeFileSync(
    join(home, 'serve.json'),
    JSON.stringify({ port: 4321, pid: process.pid, identity: 'recorded' }),
  );
  expect(recordedServerAlive()).toBe(true);
  // Its own record too: a server that cannot read what names it still holds its home.
  expect(holdsHome()).toBe(true);
  // And writes a record without it, rather than one that could never match.
  writeServePort(4322);
  expect(Object.keys(JSON.parse(readFileSync(join(home, 'serve.json'), 'utf8')) as object)).toEqual([
    'port',
    'pid',
  ]);
});
