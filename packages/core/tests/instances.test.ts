/**
 * What an earlier version's one-document akapen left behind, as `readInstances` reads it.
 *
 * A crashed process is simulated by an entry for a pid that is gone. Nothing here writes
 * through the module: the records are written by hand, as an older binary wrote them.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { instancesDir, readInstances } from '../src/instances.ts';

let home: string;

/**
 * A pid nothing is using. Walking down from a high number rather than picking one:
 * a fixed number is a process on somebody's machine.
 *
 * EPERM means a process is there and owned by someone else, which is not what is wanted.
 */
function deadPid(): number {
  for (let pid = 99_999; pid > 1; pid--) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('every pid up to 99999 is in use');
}

const write = (name: string, body: unknown): void => {
  mkdirSync(instancesDir(), { recursive: true });
  writeFileSync(join(instancesDir(), name), typeof body === 'string' ? body : JSON.stringify(body));
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'akapen-instances-'));
  process.env['AKAPEN_HOME'] = home;
});

afterEach(() => {
  delete process.env['AKAPEN_HOME'];
  rmSync(home, { recursive: true, force: true });
});

describe('reading the records of one-document processes', () => {
  it('finds nothing where no version ever wrote a record', () => {
    expect(readInstances()).toEqual([]);
  });

  it('returns the pid and the file of a record whose process is alive, however much else it holds', () => {
    write(`${process.pid}.json`, {
      pid: process.pid,
      host: '0.0.0.0',
      port: 4321,
      file: '/notes/plan.md',
      startedAt: '2026-08-18T00:00:00.000Z',
      origin: { kind: 'claude-code', id: 'abc', cwd: '/x' },
    });

    expect(readInstances()).toEqual([{ pid: process.pid, file: '/notes/plan.md' }]);
  });

  it('leaves out the record of a process that is gone, and does not delete it', () => {
    const crashed = deadPid();
    write(`${crashed}.json`, { pid: crashed, file: '/notes/gone.md' });

    expect(readInstances()).toEqual([]);
    expect(readdirSync(instancesDir())).toEqual([`${crashed}.json`]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['no file', { pid: process.pid }],
    ['no pid', { file: '/notes/plan.md' }],
    ['a pid that is not a whole number', { pid: 1.5, file: '/notes/plan.md' }],
    ['a pid that is not a number', { pid: String(process.pid), file: '/notes/plan.md' }],
    ['a pid of zero', { pid: 0, file: '/notes/plan.md' }],
    ['null', 'null'],
  ])('does not take %s for a record, and leaves the file', (_label, body) => {
    write('1234.json', body);

    expect(readInstances()).toEqual([]);
    expect(readdirSync(instancesDir())).toEqual(['1234.json']);
  });

  it('reads only .json files', () => {
    write('note.txt', { pid: process.pid, file: '/notes/plan.md' });

    expect(readInstances()).toEqual([]);
  });

  it('counts the records of every live process', () => {
    write(`${process.pid}.json`, { pid: process.pid, file: '/notes/a.md' });
    write(`${process.ppid}.json`, { pid: process.ppid, file: '/notes/b.md' });

    expect(
      readInstances()
        .map((r) => r.file)
        .toSorted(),
    ).toEqual(['/notes/a.md', '/notes/b.md']);
  });
});
