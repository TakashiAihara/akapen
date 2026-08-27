/**
 * Where the akapen a session started can be found again.
 *
 * `instances/` answers "what is running on this host". This answers "what did *I* start",
 * and it is a separate shape because of who reads it: a statusline, on every redraw, from
 * a shell script whose whole design is about not forking. A directory named by the session
 * id holding one file per instance named by its pid, each file one URL, is readable with
 * pathname expansion and the `read` builtin alone — no subshell, no JSON, no `ls`.
 *
 * One file per instance rather than one file per session. The URL is rewritten while the
 * instance runs, so two instances of one session sharing a file would be concurrent
 * writers to it, and would need locking not to drop each other's line. `instances/` chose
 * one file per instance to avoid exactly that; putting it back here would buy nothing.
 *
 * Nothing written here carries a token. This URL is the one to come back to, and coming
 * back is the case the cookie already covers — a secret in a file a statusline prints on
 * every redraw would end up in the scrollback of everything else that terminal did.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readInstances } from './instances.ts';
import { akapenHome, writeAtomic } from './store.ts';

/** One live instance, as the sweep needs to know it. */
export type SessionEntry = { sessionId: string; pid: number };

export function sessionsDir(): string {
  return join(akapenHome(), 'sessions');
}

/**
 * A session id that is a directory name and nothing else.
 *
 * It arrives from the environment, and it is joined onto a path. `..` or a separator in
 * it would put the file somewhere nobody asked for, and the id is opaque to akapen — it
 * is never parsed, only matched — so there is nothing lost by refusing the shapes that
 * are not plain names. An id that fails this is treated as no id at all.
 */
const isNameable = (id: string): boolean => id !== '' && !/[/\\:\0]/.test(id) && !/^\.+$/.test(id);

export function sessionDir(sessionId: string): string | null {
  return isNameable(sessionId) ? join(sessionsDir(), sessionId) : null;
}

/**
 * Say where this instance can be reached, replacing whatever it said before.
 *
 * Called twice over a life: once at startup with the address the startup line printed,
 * and again if somebody logs in, with the origin their browser actually holds a cookie
 * for. The second is what makes the first safe to guess at.
 *
 * `mkdirSync` on every write, not once at startup: the sweep removes a session directory
 * as soon as it is empty, and a sibling instance of the same session can do that between
 * this instance's two writes.
 *
 * Twice, because recreating it is not by itself enough. A sibling can remove the
 * directory in the window between this instance's `mkdir` and its write, and the write
 * then fails on a directory that existed a moment earlier. One retry closes it: the
 * second `mkdir` cannot lose the same race, because by then this instance has a file to
 * put in the directory and the sibling has nothing left to find empty.
 *
 * Failing here never blocks serving, for the same reason registering does not: a session
 * that cannot be found again is a lost convenience, not a lost review.
 *
 * @returns whether the url is now on disk. The caller caches what it wrote, and caching
 *   a write that did not happen would mean never trying that url again.
 */
export function recordUrl(sessionId: string, pid: number, url: string): boolean {
  const dir = sessionDir(sessionId);
  if (dir === null) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir, { recursive: true });
      writeAtomic(join(dir, String(pid)), `${url}\n`);
      return true;
    } catch (err) {
      if (attempt === 0) continue;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`akapen: could not record this instance's url for its session (${message})`);
    }
  }
  return false;
}

/** Best-effort, like `removeInstance`: shutdown must not fail over a bookkeeping file. */
export function forgetUrl(sessionId: string, pid: number = process.pid): void {
  const dir = sessionDir(sessionId);
  if (dir === null) return;
  try {
    unlinkSync(join(dir, String(pid)));
  } catch {
    /* Already gone, or never written. Nothing to undo either way. */
  }
  removeIfEmpty(dir);
}

/** `rmdir` refuses a directory that still has entries, which is the whole check. */
function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    /* Not empty, already gone, or read-only. None of those is worth reporting. */
  }
}

/**
 * Drop what no live instance stands behind, and the directories left empty by it.
 *
 * A crash leaves a file naming a pid nobody is listening on. The consumer skips it — it
 * checks the pid before printing — so nothing looks wrong, and that is exactly why this
 * has to exist: an index that never shrinks and never looks broken grows until somebody
 * has to go and find out why there are ten thousand directories.
 *
 * The caller passes what is live. Deciding it here would mean a second liveness rule
 * living beside the registry's, and a pid alone is not one: pids are reused, so a file
 * left by a crash sits behind an unrelated process and reads as current. The session id
 * is compared as well as the pid, so a reused pid cannot keep another session's entry.
 */
export function sweep(live: Iterable<SessionEntry>): void {
  const root = sessionsDir();
  if (!existsSync(root)) return;
  const alive = new Set<string>();
  for (const entry of live) alive.add(`${entry.sessionId} ${entry.pid}`);

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }

  for (const sessionId of names) {
    const dir = sessionDir(sessionId);
    if (dir === null) continue;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      // A file where a directory was expected, or one removed underneath us. Neither is
      // something to repair from here.
      continue;
    }
    for (const name of files) {
      if (alive.has(`${sessionId} ${name}`)) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* Someone else got there first, or it is read-only. */
      }
    }
    removeIfEmpty(dir);
  }
}

/**
 * What the registry says is running, in the shape `sweep` compares against.
 *
 * `readInstances`, not `liveInstances`: an instance that does not answer a probe may
 * simply be busy, and the registry keeps its entry for exactly that reason. Deleting the
 * url of something the registry still vouches for would contradict it.
 */
export function liveEntries(): SessionEntry[] {
  return readInstances().flatMap((r) =>
    r.origin?.id === undefined ? [] : [{ sessionId: r.origin.id, pid: r.pid }],
  );
}

/** What one session started, as the entries currently on disk say. */
export function readUrls(sessionId: string): { pid: number; url: string }[] {
  const dir = sessionDir(sessionId);
  if (dir === null || !existsSync(dir)) return [];
  const out: { pid: number; url: string }[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // A file where a directory was expected. `existsSync` is true for it, so the guard
    // above lets it through — the same case `sweep` steps over rather than throwing on.
    return [];
  }
  for (const name of names) {
    const pid = /^\d+$/.test(name) ? Number(name) : NaN;
    if (!Number.isInteger(pid)) continue;
    try {
      const url = readFileSync(join(dir, name), 'utf8').trim();
      if (url !== '') out.push({ pid, url });
    } catch {
      /* Removed between the listing and the read. */
    }
  }
  return out.toSorted((a, b) => a.pid - b.pid);
}
