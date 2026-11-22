/**
 * A pid is handed to a later process once its own is gone. What is worth breaking a test
 * over: a record that names a dead server's pid must stop counting as that server the
 * moment somebody else holds the number (#323).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readServeRecord, recordedServerAlive, writeServePort } from '../src/documents.ts';
import { processIdentity } from '../src/process.ts';

const tick = (identity: string | null) => Number(identity!.split(':')[1]);

describe('what names a process beside its pid', () => {
  it('is read for this process, and is the same each time', () => {
    const mine = processIdentity(process.pid);
    expect(mine).toMatch(/\S/);
    expect(processIdentity(process.pid)).toBe(mine);
    // On Linux, which values: the boot's id and a count of ticks, not some other field of the line.
    if (process.platform === 'linux') {
      expect(mine).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+$/);
    }
  });

  it('differs for another process, and is not read for one that is gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const exited = new Promise<void>((done) => child.on('exit', () => done()));
    try {
      const theirs = processIdentity(child.pid!);
      expect(theirs).toMatch(/\S/);
      expect(theirs).not.toBe(processIdentity(process.pid));
      // The tick it started at, which for a process started later is not an earlier one.
      if (process.platform === 'linux') {
        expect(tick(theirs)).toBeGreaterThanOrEqual(tick(processIdentity(process.pid)));
        expect(tick(theirs) - tick(processIdentity(process.pid))).toBeLessThan(100 * 3600);
      }
    } finally {
      child.kill();
      await exited;
    }
    expect(processIdentity(child.pid!)).toBeNull();
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

  it('is written with what names its process, and counts as running', () => {
    writeServePort(4321);
    expect(readServeRecord()).toEqual({
      port: 4321,
      pid: process.pid,
      identity: processIdentity(process.pid),
    });
    expect(recordedServerAlive()).toBe(true);
  });

  it('is gone when its pid lives but is another process than the one recorded', () => {
    record({ port: 4321, pid: process.pid, identity: `${processIdentity(process.pid)}0` });
    expect(recordedServerAlive()).toBe(false);
  });

  it('is judged by the pid alone when the record does not say which process', () => {
    record({ port: 4321, pid: process.pid });
    expect(recordedServerAlive()).toBe(true);
    record({ port: 4321, pid: 2 ** 22 + 1, identity: 'x' });
    expect(recordedServerAlive()).toBe(false);
  });
});
