/**
 * One server per home (#324). The record a server writes on start is the lock: what is
 * worth breaking a test over is two servers both believing the home is theirs, each
 * writing documents.json from its own copy.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimHome,
  holdsHome,
  HomeHeldError,
  readServeRecord,
  releaseHome,
  writeServePort,
} from '../src/documents.ts';
import { processIdentity } from '../src/process.ts';

let home: string;
let other: ChildProcess;
const record = () => join(home, 'serve.json');
const write = (rec: unknown) => writeFileSync(record(), JSON.stringify(rec));
const read = () => JSON.parse(readFileSync(record(), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'akapen-home-'));
  process.env['AKAPEN_HOME'] = home;
  // Another process that lives for the length of a test, to stand for a running server.
  other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
});

afterEach(async () => {
  const exited = new Promise<void>((done) => other.on('exit', () => done()));
  other.kill();
  await exited;
  delete process.env['AKAPEN_HOME'];
  rmSync(home, { recursive: true, force: true });
});

describe('taking the home', () => {
  it('writes a record naming this process, without a port until one is known', () => {
    claimHome();
    expect(read()).toEqual({ pid: process.pid, identity: processIdentity(process.pid) });
    expect(holdsHome()).toBe(true);
    // Nothing left beside it from putting it there.
    expect(readdirSync(home)).toEqual(['serve.json']);
    // Nothing for a client to reach yet.
    expect(readServeRecord()).toBeNull();
    writeServePort(4321);
    expect(holdsHome()).toBe(true);
    expect(readServeRecord()?.port).toBe(4321);
  });

  it('is refused while the process a record names is running, and leaves the record as it was', () => {
    const theirs = { port: 4321, pid: other.pid, identity: processIdentity(other.pid!) };
    write(theirs);
    expect(() => claimHome()).toThrow(HomeHeldError);
    expect(read()).toEqual(theirs);
    expect(holdsHome()).toBe(false);
    try {
      claimHome();
    } catch (err) {
      expect((err as HomeHeldError).holder).toEqual({ pid: other.pid, port: 4321 });
    }
  });

  it('is refused by a record that names a live pid and nothing more, as one from before did', () => {
    write({ port: 4321, pid: other.pid });
    expect(() => claimHome()).toThrow(HomeHeldError);
  });

  it.each([
    ['whose process is gone', () => ({ port: 4321, pid: 2 ** 22 + 1 })],
    [
      'whose pid was given to another process',
      () => ({ port: 4321, pid: other.pid, identity: 'not that one' }),
    ],
    ['naming this very pid, left by an earlier holder of it', () => ({ port: 4321, pid: process.pid })],
    ['that cannot be read as one', () => 'not a record'],
  ])('takes over a record %s', (_what, left) => {
    write(left());
    claimHome();
    expect(read()).toEqual({ pid: process.pid, identity: processIdentity(process.pid) });
  });
});

describe('two servers taking the home at once', () => {
  const lock = () => join(home, 'serve.json.taking');

  it('waits for the other, then reads the record again rather than writing over what it saw', async () => {
    // A record of a crash, and another server in the middle of taking it over.
    write({ port: 4321, pid: 2 ** 22 + 1 });
    mkdirSync(lock());
    const claiming = spawn(
      'bun',
      [
        '-e',
        `const d = await import(${JSON.stringify(join(import.meta.dirname, '..', 'src', 'documents.ts'))});
         try { d.claimHome(); console.log('took it'); }
         catch (err) { console.log(err instanceof d.HomeHeldError ? 'held by ' + err.holder.pid : String(err)); }`,
      ],
      { env: { ...process.env, AKAPEN_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let said = '';
    claiming.stdout.on('data', (c: Buffer) => (said += c.toString()));
    const exited = new Promise<void>((done) => claiming.on('exit', () => done()));
    try {
      // Long enough for it to have read the dead record, had it not waited.
      await new Promise((r) => setTimeout(r, 700));
      expect(said).toBe('');
      const theirs = { port: 4322, pid: other.pid, identity: processIdentity(other.pid!) };
      write(theirs);
      rmSync(lock(), { recursive: true });
      await exited;
      expect(said.trim()).toBe(`held by ${other.pid}`);
      expect(read()).toEqual(theirs);
    } finally {
      claiming.kill();
      await exited;
    }
  }, 15_000);

  it('gives up on one that never finishes, and writes nothing', () => {
    write({ port: 4321, pid: 2 ** 22 + 1 });
    mkdirSync(lock());
    const began = Date.now();
    expect(() => claimHome()).toThrow(
      `another akapen serve is starting for ${home}; if none is, remove ${lock()}`,
    );
    expect(Date.now() - began).toBeGreaterThanOrEqual(1_900);
    expect(Date.now() - began).toBeLessThan(6_000);
    expect(read()).toEqual({ port: 4321, pid: 2 ** 22 + 1 });
  }, 15_000);

  it('takes over from one that died while taking the home', () => {
    mkdirSync(lock());
    const longAgo = new Date(Date.now() - 11_000);
    utimesSync(lock(), longAgo, longAgo);
    const began = Date.now();
    claimHome();
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(read()).toEqual({ pid: process.pid, identity: processIdentity(process.pid) });
    expect(readdirSync(home)).toEqual(['serve.json']);
  });

  it('does not take one for dead that began a moment ago', () => {
    mkdirSync(lock());
    const recent = new Date(Date.now() - 5_000);
    utimesSync(lock(), recent, recent);
    expect(() => claimHome()).toThrow('another akapen serve is starting');
  }, 15_000);
});

describe('giving the home up', () => {
  it('removes its own record', () => {
    claimHome();
    releaseHome();
    expect(() => read()).toThrow();
  });

  it("leaves another server's record, and no longer holds the home", () => {
    claimHome();
    const theirs = { port: 4321, pid: other.pid, identity: processIdentity(other.pid!) };
    write(theirs);
    expect(holdsHome()).toBe(false);
    releaseHome();
    expect(read()).toEqual(theirs);
    // One with this pid that says nothing more is this server's, as a record from before was.
    write({ port: 4321, pid: process.pid });
    expect(holdsHome()).toBe(true);
    // Not one with this pid that names another process: a server in another container.
    write({ port: 4321, pid: process.pid, identity: 'not this process' });
    expect(holdsHome()).toBe(false);
    // A record that names another pid and nothing more is not this server's either.
    write({ port: 4321, pid: other.pid });
    expect(holdsHome()).toBe(false);
  });
});
