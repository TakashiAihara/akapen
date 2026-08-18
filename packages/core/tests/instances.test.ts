/**
 * The registry of running instances.
 *
 * This is where the feature can rot without anything looking wrong: a stale entry is a
 * row that is there to be clicked and goes nowhere, and an entry that is never removed
 * makes every reader spend a timeout on a port nobody is listening on. Neither shows up
 * anywhere else, so it is checked here.
 *
 * A crashed instance is simulated by leaving an entry for a pid that is gone.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  instancesDir,
  liveInstances,
  readInstances,
  registerInstance,
  removeInstance,
  type InstanceRecord,
} from '../src/instances.ts';

let home: string;

/**
 * A pid nothing is using. Walking down from a high number rather than picking one:
 * a fixed number is a process on somebody's machine, and the whole point of the entry
 * being stale is that the pid is gone.
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

const record = (over: Partial<InstanceRecord> = {}): InstanceRecord => ({
  pid: process.pid,
  host: '127.0.0.1',
  port: 4300,
  file: '/tmp/note.md',
  startedAt: '2026-08-18T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'akapen-instances-'));
  process.env['AKAPEN_HOME'] = home;
});

afterEach(() => {
  delete process.env['AKAPEN_HOME'];
  rmSync(home, { recursive: true, force: true });
});

/** Something listening that answers like an instance would. */
async function listening(body: unknown): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: (server.address() as AddressInfo).port,
    stop: () =>
      new Promise<void>((done) => {
        // fetch keeps the connection alive, so waiting for it to go idle never returns
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** A port nothing is listening on, so connecting to it is refused rather than hanging. */
async function freePort(): Promise<number> {
  const server = await listening({});
  const { port } = server;
  await server.stop();
  return port;
}

describe('writing an entry', () => {
  it('names the file after the pid and stores identity only', () => {
    registerInstance(record({ port: 4321 }));

    const written = readdirSync(instancesDir());
    expect(written).toEqual([`${process.pid}.json`]);
    const stored: unknown = JSON.parse(readFileSync(join(instancesDir(), written[0]!), 'utf8'));
    // Round and unresolved change on every comment. An entry holding them would have to
    // be rewritten that often, and would be wrong the rest of the time.
    expect(stored).toEqual({
      pid: process.pid,
      host: '127.0.0.1',
      port: 4321,
      file: '/tmp/note.md',
      startedAt: '2026-08-18T00:00:00.000Z',
    });
  });

  it('creates the directory rather than expecting one', () => {
    expect(existsSync(instancesDir())).toBe(false);
    registerInstance(record());
    expect(readInstances()).toHaveLength(1);
  });

  it('never throws when the home cannot be written', () => {
    // A read-only or missing AKAPEN_HOME costs the switcher, not the review.
    process.env['AKAPEN_HOME'] = join(home, 'missing', '\0invalid');
    expect(() => registerInstance(record())).not.toThrow();
  });
});

describe('removing an entry', () => {
  it('deletes the file for the given pid', () => {
    registerInstance(record());
    removeInstance();
    expect(readdirSync(instancesDir())).toEqual([]);
  });

  it('leaves the others alone', () => {
    const other = deadPid();
    registerInstance(record());
    registerInstance(record({ pid: other, port: 4301 }));

    removeInstance(other);

    expect(readdirSync(instancesDir())).toEqual([`${process.pid}.json`]);
  });

  it('says nothing when there is no entry to remove', () => {
    // Shutdown runs it whether or not registering worked, so a missing entry is normal.
    expect(() => removeInstance()).not.toThrow();
  });
});

describe('reading the registry', () => {
  it('drops an entry whose process is gone, and deletes it as it goes', () => {
    const crashed = deadPid();
    registerInstance(record());
    registerInstance(record({ pid: crashed, port: 4301 }));

    expect(readInstances().map((r) => r.pid)).toEqual([process.pid]);
    // Deleted, not just skipped: otherwise every read after a crash pays for it again.
    expect(existsSync(join(instancesDir(), `${crashed}.json`))).toBe(false);
  });

  it('drops an entry that is not readable as a record', () => {
    mkdirSync(instancesDir(), { recursive: true });
    writeFileSync(join(instancesDir(), '1234.json'), 'not json');
    writeFileSync(join(instancesDir(), '1235.json'), JSON.stringify({ pid: process.pid }));
    registerInstance(record());

    expect(readInstances().map((r) => r.pid)).toEqual([process.pid]);
    expect(readdirSync(instancesDir())).toEqual([`${process.pid}.json`]);
  });

  it('is empty, not an error, before anything has registered', () => {
    expect(readInstances()).toEqual([]);
  });
});

describe('proving an instance is alive', () => {
  it('lists only the entries that answer, and keeps the silent one on disk', async () => {
    // Both pids are alive, so the pid check passes for both and only the request tells
    // them apart. Pids are reused, which is why the check is not enough on its own.
    const answering = await listening({ file: 'note.md', round: 2, unresolved: 3 });
    const silentPort = await freePort();

    registerInstance(record({ pid: process.pid, port: answering.port }));
    // A second entry needs a second file, so it needs a second pid whose process still
    // exists. The parent is one.
    registerInstance(record({ pid: process.ppid, port: silentPort }));

    const live = await liveInstances({ timeoutMs: 2_000 });

    expect(live).toHaveLength(1);
    expect(live[0]!.record.port).toBe(answering.port);
    expect(live[0]!.status).toEqual({ file: 'note.md', round: 2, unresolved: 3 });
    // Left alone on purpose: its pid is alive, so it may be an instance that was busy.
    expect(existsSync(join(instancesDir(), `${process.ppid}.json`))).toBe(true);

    await answering.stop();
  });

  it('leaves out the caller when asked to', async () => {
    const own = await listening({ file: 'note.md', round: 1, unresolved: 0 });
    registerInstance(record({ pid: process.pid, port: own.port }));

    expect(await liveInstances({ excludePid: process.pid })).toEqual([]);

    await own.stop();
  });

  it('ignores an answer that is not a status', async () => {
    // Whatever is on that port now, it is not an akapen just because it replied.
    const impostor = await listening({ hello: 'there' });
    registerInstance(record({ pid: process.pid, port: impostor.port }));

    expect(await liveInstances({ timeoutMs: 2_000 })).toEqual([]);

    await impostor.stop();
  });
});
