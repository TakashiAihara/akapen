/**
 * The akapen processes running for this user, and how to find them again.
 *
 * One akapen is one file and one process. On a host running several, the port each of
 * them took exists in exactly one place — the startup line of whoever started it — and
 * once that has scrolled away the review is running and unreachable. Every instance
 * drops a file naming itself here, so the others can be found without remembering.
 *
 * The file holds identity only. The round number and the unresolved count change on
 * every comment, and a registry that has to be rewritten that often is a registry that
 * will be wrong; those are asked of the instance itself over `/api/status`, which is
 * the same request that proves it is still alive.
 *
 * Only instances sharing this `AKAPEN_HOME` are visible. Reaching across hosts is a
 * different thing entirely (#13) and is not built here.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { StatusPayload } from '@akapen/shared';
import { akapenHome, writeAtomic } from './store.ts';

/** What an instance writes about itself. Nothing in here changes while it runs. */
export type InstanceRecord = {
  pid: number;
  /** The address it was told to bind. `0.0.0.0` and `127.0.0.1` mean very different things to a reader. */
  host: string;
  port: number;
  /** Absolute path of the file under review. */
  file: string;
  startedAt: string;
};

/** An instance that answered. The state is what it reported, not what the file said. */
export type LiveInstance = { record: InstanceRecord; status: StatusPayload };

/** One file per instance: no concurrent writers, so no locking, so nothing to get wrong. */
export function instancesDir(): string {
  return join(akapenHome(), 'instances');
}

function instanceFile(pid: number): string {
  return join(instancesDir(), `${pid}.json`);
}

/**
 * Announce this instance.
 *
 * Failing here never blocks serving: a read-only or missing `AKAPEN_HOME` costs the
 * switcher, not the review, so it is logged and stepped over. Written atomically, so a
 * reader never sees half a record.
 */
export function registerInstance(record: InstanceRecord): void {
  try {
    mkdirSync(instancesDir(), { recursive: true });
    writeAtomic(instanceFile(record.pid), JSON.stringify(record, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`akapen: could not register this instance; the others will not see it (${message})`);
  }
}

/** Best-effort: shutdown must not fail because the entry was already gone. */
export function removeInstance(pid: number = process.pid): void {
  try {
    unlinkSync(instanceFile(pid));
  } catch {
    /* Already removed, or never written. Either way there is nothing to clean up. */
  }
}

/**
 * `kill(pid, 0)` sends no signal; it only asks whether a process with that id is there.
 * `EPERM` means one is, owned by somebody else — still a reason not to drop the entry.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A host that means what it says once it is put in a URL.
 *
 * An entry is written by akapen, but it is read as a file on disk, and `host` and `port`
 * go straight into the address the liveness check asks. A host carrying `/`, `@`, `?` or
 * `#` moves what that URL points at, so a corrupted entry would aim the request at
 * somewhere nobody asked for. IPv6 literals are written bracketed or bare, and both stay
 * allowed — rejecting them would delete the entries of anyone who bound one.
 */
const isAddressable = (host: string): boolean => host !== '' && !/[/@?#\s\\]/.test(host);

function isRecord(v: unknown): v is InstanceRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as InstanceRecord;
  return (
    Number.isInteger(r.pid) &&
    r.pid > 0 &&
    typeof r.host === 'string' &&
    isAddressable(r.host) &&
    Number.isInteger(r.port) &&
    // The same range the contract states. A port outside it cannot be listening, so the
    // entry is stale rather than merely odd, and it is deleted like any other stale one.
    r.port > 0 &&
    r.port <= 65_535 &&
    typeof r.file === 'string' &&
    typeof r.startedAt === 'string'
  );
}

/**
 * Every entry whose process still exists, cheapest check first.
 *
 * A crash leaves the entry behind, so entries that cannot be read or name a process
 * that is gone are deleted as they are found and the directory heals itself. An entry
 * that survives this is not yet proof of anything: pids are reused, and the process
 * holding one may have nothing to do with akapen. That is what `liveInstances` asks.
 */
export function readInstances(): InstanceRecord[] {
  const dir = instancesDir();
  if (!existsSync(dir)) return [];
  const out: InstanceRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let record: InstanceRecord | null = null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isRecord(parsed) && alive(parsed.pid)) record = parsed;
    } catch {
      /* Unreadable or not JSON. Indistinguishable from gone, and treated the same. */
    }
    if (record) out.push(record);
    else removeStale(path);
  }
  return out.toSorted((a, b) => a.port - b.port);
}

function removeStale(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* Someone else got there first, or the directory is read-only. Not worth reporting. */
  }
}

function isStatus(v: unknown): v is StatusPayload {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as StatusPayload;
  return typeof s.file === 'string' && Number.isInteger(s.round) && Number.isInteger(s.unresolved);
}

/**
 * Where to reach an instance from this host.
 *
 * A wildcard bind is not an address anything can connect to, so it becomes loopback.
 * Anything else is the address it is actually listening on — a bind to one LAN
 * interface answers there and nowhere else, and assuming loopback would report it dead.
 */
function probeHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '[::1]';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Ask one instance what it is showing.
 *
 * This is the liveness check. The entry existing says only that a process with that pid
 * exists; only an answer says it is the akapen that wrote the entry. A silent one is
 * left in the directory rather than deleted — its pid is alive, so it may simply be busy.
 */
async function askStatus(record: InstanceRecord, timeoutMs: number): Promise<StatusPayload | null> {
  try {
    const res = await fetch(`http://${probeHost(record.host)}:${record.port}/api/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const parsed: unknown = await res.json();
    return isStatus(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every instance that is really there, with what it is showing.
 *
 * @param opts.excludePid  the caller's own pid, when the caller is one of them
 * @param opts.timeoutMs   a peer on the same host answers immediately or not at all
 */
export async function liveInstances(
  opts: { excludePid?: number; timeoutMs?: number } = {},
): Promise<LiveInstance[]> {
  const timeoutMs = opts.timeoutMs ?? 500;
  const records = readInstances().filter((r) => r.pid !== opts.excludePid);
  // Asked all at once: one instance that is slow to answer must not add its timeout to
  // the wait for every instance after it.
  const probed = await Promise.all(
    records.map(async (record) => {
      const status = await askStatus(record, timeoutMs);
      return status ? { record, status } : null;
    }),
  );
  return probed.filter((entry): entry is LiveInstance => entry !== null);
}
