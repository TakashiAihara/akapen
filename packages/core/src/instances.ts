/**
 * What an earlier version's one-document akapen left under `~/.akapen/instances/`.
 *
 * Nothing writes there any more. It is still read in two places, both about a process that
 * may still be running from before an upgrade: `akapen serve` refuses to register a file
 * such a process serves, and does not move `reviews/` to `comments/` while one runs. Both
 * would otherwise put a second holder on a store that process writes into.
 *
 * Read only: an entry whose process is gone is left where it is, since nothing here has
 * any reason to delete files in a directory no version writes to.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { akapenHome } from './store.ts';

/** The two things of an old record that anything reads. */
export type InstanceRecord = {
  pid: number;
  /** Absolute path of the file that process serves. */
  file: string;
  /** Where the record is, for a message: something to look at, or to delete. */
  record: string;
};

export function instancesDir(): string {
  return join(akapenHome(), 'instances');
}

/**
 * `kill(pid, 0)` sends no signal; it only asks whether a process with that id is there.
 * `EPERM` means one is, owned by somebody else, which still counts.
 *
 * The pid is all there is to go by (#323). A record holds the time it was written, but
 * setting that against when the process started compares two readings of a clock that may
 * have been set in between (a machine without a clock of its own starts in the past and is
 * corrected later), and getting it wrong takes a running holder for gone: a second holder
 * on its store. A later process given the pid keeps the record alive instead, which the
 * refusal makes something to act on by saying where the record is.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The records whose process is still there. One that cannot be read is not one. */
export function readInstances(): InstanceRecord[] {
  const dir = instancesDir();
  if (!existsSync(dir)) return [];
  const out: InstanceRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<InstanceRecord> | null;
      if (
        typeof parsed?.pid === 'number' &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.file === 'string' &&
        alive(parsed.pid)
      ) {
        out.push({ pid: parsed.pid, file: parsed.file, record: join(dir, name) });
      }
    } catch {
      /* Unreadable or not JSON: not a record. */
    }
  }
  return out;
}
