/**
 * The reverse index, and the two ways it goes wrong quietly.
 *
 * Nothing here is about whether a url is correct — that is `addresses.test.ts`. It is
 * about an index that never looks broken: a file left by a crash is skipped by every
 * reader, so the only symptom of never cleaning up is that after some months there are
 * thousands of directories. And a pid alone cannot decide what to keep, because pids
 * come round again, so the sweep has to be shown that it compares the session too.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetUrl, readUrls, recordUrl, sessionDir, sessionsDir, sweep } from '../src/sessions.ts';

const SESSION = 'f8f3b87b-e51b-4f8e-ac92-1e743787d779';
const OTHER = '2b7c1d40-0000-4000-8000-000000000000';

let home: string;
let previous: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'akapen-sessions-'));
  previous = process.env['AKAPEN_HOME'];
  process.env['AKAPEN_HOME'] = home;
});

afterEach(() => {
  if (previous === undefined) delete process.env['AKAPEN_HOME'];
  else process.env['AKAPEN_HOME'] = previous;
  rmSync(home, { recursive: true, force: true });
});

const url = (port: number) => `http://192.168.0.151:${String(port)}`;

describe('recording where a session can come back to', () => {
  it('writes one file per instance, named by pid', () => {
    recordUrl(SESSION, 4321, url(4300));
    recordUrl(SESSION, 4322, url(4301));
    expect(readUrls(SESSION)).toEqual([
      { pid: 4321, url: url(4300) },
      { pid: 4322, url: url(4301) },
    ]);
  });

  it('replaces what an instance said before, rather than adding to it', () => {
    // The second write is the login rewriting a guess. Appending would leave the wrong
    // url in place beside the right one, with nothing to say which is which.
    recordUrl(SESSION, 4321, url(4300));
    recordUrl(SESSION, 4321, 'http://localhost:4300');
    expect(readUrls(SESSION)).toEqual([{ pid: 4321, url: 'http://localhost:4300' }]);
  });

  it('writes the url on a line of its own, so a shell can read it with `read`', () => {
    // The consumer is a statusline that cannot afford to fork. `read -r url < file` is
    // the whole of its parsing, and it wants a newline to stop at.
    recordUrl(SESSION, 4321, url(4300));
    const raw = readdirSync(sessionDir(SESSION)!);
    expect(raw).toEqual(['4321']);
  });

  it('recreates the directory a sibling swept away between two writes', () => {
    recordUrl(SESSION, 4321, url(4300));
    forgetUrl(SESSION, 4321);
    expect(existsSync(sessionDir(SESSION)!)).toBe(false);
    // The login of a still-running instance arrives after the directory is gone. Without
    // the mkdir on every write this is the case that silently records nothing.
    recordUrl(SESSION, 4322, url(4301));
    expect(readUrls(SESSION)).toEqual([{ pid: 4322, url: url(4301) }]);
  });

  it('takes only its own entry when one instance stops', () => {
    recordUrl(SESSION, 4321, url(4300));
    recordUrl(SESSION, 4322, url(4301));
    forgetUrl(SESSION, 4321);
    expect(readUrls(SESSION)).toEqual([{ pid: 4322, url: url(4301) }]);
    // And the directory survives, because the sibling is still in it.
    expect(existsSync(sessionDir(SESSION)!)).toBe(true);
  });

  it('refuses a session id that is not a plain directory name', () => {
    // It comes from the environment and is joined onto a path. Nothing about it is
    // parsed, so refusing the shapes that could escape the directory costs nothing.
    for (const bad of ['../escape', 'a/b', '..', '', 'a\\b']) {
      expect(sessionDir(bad)).toBeNull();
      recordUrl(bad, 4321, url(4300));
    }
    expect(existsSync(sessionsDir())).toBe(false);
  });
});

describe('sweeping what no live instance stands behind', () => {
  it('removes the entry of a pid nothing is running under', () => {
    recordUrl(SESSION, 4321, url(4300));
    recordUrl(SESSION, 4322, url(4301));
    sweep([{ sessionId: SESSION, pid: 4322 }]);
    expect(readUrls(SESSION)).toEqual([{ pid: 4322, url: url(4301) }]);
  });

  it('removes the directory once its last entry goes', () => {
    // The failure this covers is not visible from the outside: readers skip a dead pid,
    // so an index that never shrinks reads exactly like one that does.
    recordUrl(SESSION, 4321, url(4300));
    sweep([]);
    expect(existsSync(sessionDir(SESSION)!)).toBe(false);
    expect(readdirSync(sessionsDir())).toEqual([]);
  });

  it('keeps a directory that still has a live entry', () => {
    recordUrl(SESSION, 4321, url(4300));
    recordUrl(SESSION, 4322, url(4301));
    sweep([{ sessionId: SESSION, pid: 4321 }]);
    expect(existsSync(sessionDir(SESSION)!)).toBe(true);
    expect(readUrls(SESSION)).toEqual([{ pid: 4321, url: url(4300) }]);
  });

  it('does not let a reused pid keep another session’s entry', () => {
    // pids come round — on the machine this was written on the counter turns over in
    // hours — so "some live instance has this pid" is not the same question as "this
    // entry is current", and answering the first would leave a dead url on screen.
    recordUrl(SESSION, 4321, url(4300));
    recordUrl(OTHER, 4321, url(4301));
    sweep([{ sessionId: OTHER, pid: 4321 }]);
    expect(readUrls(SESSION)).toEqual([]);
    expect(readUrls(OTHER)).toEqual([{ pid: 4321, url: url(4301) }]);
  });

  it('leaves alone the sessions of instances it was not told about', () => {
    // The other direction. A sweep that removed everything it could not vouch for would
    // wipe the index every time it ran with a short list.
    recordUrl(SESSION, 4321, url(4300));
    recordUrl(OTHER, 4322, url(4301));
    sweep([
      { sessionId: SESSION, pid: 4321 },
      { sessionId: OTHER, pid: 4322 },
    ]);
    expect(readUrls(SESSION)).toHaveLength(1);
    expect(readUrls(OTHER)).toHaveLength(1);
  });

  it('steps over anything in the directory that is not one of its files', () => {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(join(sessionsDir(), 'stray'), 'not a directory');
    recordUrl(SESSION, 4321, url(4300));
    expect(() => sweep([{ sessionId: SESSION, pid: 4321 }])).not.toThrow();
    expect(readUrls(SESSION)).toHaveLength(1);
  });

  it('does nothing at all when there is no index yet', () => {
    expect(() => sweep([])).not.toThrow();
    expect(readUrls(SESSION)).toEqual([]);
  });
});
