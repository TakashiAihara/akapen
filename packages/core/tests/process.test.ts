/**
 * A pid is handed to a later process once its own is gone. What is worth breaking a test
 * over: a record that names a dead server's pid must stop counting as that server the
 * moment somebody else holds the number (#323).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readServeRecord, recordedServerAlive, writeServePort } from '../src/documents.ts';
import { processStartedAt } from '../src/process.ts';

describe('when a process started', () => {
  it('is read for this process, the same each time, and not later than now', () => {
    const at = processStartedAt(process.pid);
    expect(at).not.toBeNull();
    expect(processStartedAt(process.pid)).toBe(at);
    // Within the second the platform reports it to, and after this process had run for a while.
    expect(at!).toBeLessThanOrEqual(Date.now() - process.uptime() * 1000 + 1_500);
    expect(at!).toBeGreaterThan(Date.now() - process.uptime() * 1000 - 5_000);
  });

  it('differs for a process started later', () => {
    const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid); setTimeout(() => {}, 0)'], {
      encoding: 'utf8',
    });
    expect(child.status).toBe(0);
    // Gone by now: nothing to read for an id nobody holds.
    expect(processStartedAt(Number(child.stdout.trim()))).toBeNull();
    expect(processStartedAt(1)).toBeLessThan(processStartedAt(process.pid)!);
  });
});

describe('the server a home recorded', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'akapen-serve-record-'));
    process.env['AKAPEN_HOME'] = home;
  });
  afterEach(() => {
    delete process.env['AKAPEN_HOME'];
    rmSync(home, { recursive: true, force: true });
  });
  const record = (rec: unknown) => writeFileSync(join(home, 'serve.json'), JSON.stringify(rec));

  it('is written with when its process started, and counts as running', () => {
    writeServePort(4321);
    expect(readServeRecord()).toEqual({
      port: 4321,
      pid: process.pid,
      started: processStartedAt(process.pid),
    });
    expect(recordedServerAlive()).toBe(true);
  });

  it('is gone when its pid lives but started at another moment', () => {
    record({ port: 4321, pid: process.pid, started: processStartedAt(process.pid)! - 60_000 });
    expect(recordedServerAlive()).toBe(false);
  });

  it('is judged by the pid alone when the record says nothing of the start', () => {
    record({ port: 4321, pid: process.pid });
    expect(recordedServerAlive()).toBe(true);
    record({ port: 4321, pid: 2 ** 22 + 1, started: 1 });
    expect(recordedServerAlive()).toBe(false);
  });
});
