/**
 * The documents a long-lived `akapen serve` hands out (#305).
 *
 * One file, written only by the server: the CLI registers and unregisters through the
 * server's API, so there is a single writer and no lock. docs/design/multi-document-server.md
 * has the decisions behind it.
 */
import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { processIdentity } from './process.ts';
import { akapenHome, commentsRoot, storeDir, writeAtomic } from './store.ts';

export type DocumentEntry = {
  /** The URL segment: `/d/<id>/`. The store directory's name, so it follows from the path. */
  id: string;
  /** Resolved, as the store keys it. */
  file: string;
  /** The Claude Code session that registered it, when there was one. */
  session?: string;
  /** Where images beside the document may be served from. Absent: the document's directory. */
  root?: string;
  addedAt: string;
};

export function documentsPath(): string {
  return join(akapenHome(), 'documents.json');
}

/** The same value as the store directory's name, so a document's URL and its comments move together. */
export function documentId(file: string): string {
  return basename(storeDir(resolve(file)));
}

const isEntry = (v: unknown): v is DocumentEntry => {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as DocumentEntry;
  return (
    typeof e.id === 'string' &&
    typeof e.file === 'string' &&
    typeof e.addedAt === 'string' &&
    (e.session === undefined || typeof e.session === 'string') &&
    (e.root === undefined || typeof e.root === 'string')
  );
};

/**
 * What is registered. A missing file is none. A file that cannot be parsed throws: read
 * as empty, the next write would replace every registration with what came after it.
 */
export function readDocuments(): DocumentEntry[] {
  let raw: string;
  try {
    raw = readFileSync(documentsPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const parsed = JSON.parse(raw) as { version?: unknown; documents?: unknown };
  // A newer layout read as this one would be rewritten as this one on the next write.
  if (parsed.version !== 1)
    throw new Error(`${documentsPath()}: version ${String(parsed.version)} is not one this akapen reads`);
  if (!Array.isArray(parsed.documents)) throw new Error(`${documentsPath()}: no documents array`);
  // Refused rather than skipped: a row left out here is gone after the next write.
  const bad = parsed.documents.findIndex((e) => !isEntry(e));
  if (bad !== -1) throw new Error(`${documentsPath()}: entry ${bad} is not a registration; fix or remove it`);
  return parsed.documents as DocumentEntry[];
}

export function writeDocuments(entries: DocumentEntry[]): void {
  mkdirSync(akapenHome(), { recursive: true });
  writeAtomic(documentsPath(), `${JSON.stringify({ version: 1, documents: entries }, null, 2)}\n`);
}

/**
 * Where the running `akapen serve` listens. Clients find it here, and a second server on
 * the same home finds it and refuses to start: two would each write `documents.json` from
 * their own copy.
 */
export function servePath(): string {
  return join(akapenHome(), 'serve.json');
}

export function readServePort(): number | null {
  return readServeRecord()?.port ?? null;
}

/**
 * What the running server recorded: its port, its pid when the record has one, and what
 * else names that process when the server could tell (#323). `identity` is compared for
 * equality and is not a time.
 */
export function readServeRecord(): { port: number; pid: number | null; identity: string | null } | null {
  const rec = parseServeRecord(readServeText());
  // Without a port it is a server still starting: nothing to reach yet.
  return rec === null || rec.port === null ? null : { ...rec, port: rec.port };
}

type ServeRecord = { port: number | null; pid: number | null; identity: string | null };

const readServeText = (): string | null => {
  try {
    return readFileSync(servePath(), 'utf8');
  } catch {
    return null;
  }
};

function parseServeRecord(text: string | null): ServeRecord | null {
  if (text === null) return null;
  try {
    const { port, pid, identity } = JSON.parse(text) as { port?: unknown; pid?: unknown; identity?: unknown };
    return {
      port: typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null,
      pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
      identity: typeof identity === 'string' ? identity : null,
    };
  } catch {
    return null;
  }
}

/** Whether the process a record names is still that process (#323). */
function recordLives(rec: ServeRecord | null): boolean {
  if (rec === null || rec.pid === null) return false;
  try {
    process.kill(rec.pid, 0);
    // Compared only when both are known: a record from before this was written, or a
    // platform where the start cannot be read, is judged by the pid alone, as it was.
    const identity = rec.identity === null ? null : processIdentity(rec.pid);
    return identity === null || identity === rec.identity;
  } catch {
    return false;
  }
}

const ownRecord = (port?: number): string => {
  const identity = processIdentity(process.pid);
  return `${JSON.stringify({
    ...(port === undefined ? {} : { port }),
    pid: process.pid,
    ...(identity === null ? {} : { identity }),
  })}\n`;
};

/** A home another running server holds: `akapen serve` does not start on it. */
export class HomeHeldError extends Error {
  constructor(readonly holder: { pid: number; port: number | null }) {
    super(`akapen serve is already running for ${akapenHome()} (pid ${holder.pid})`);
  }
}

/**
 * Take the home for a server that is starting, before it reads anything it will write
 * (#324). The record is the lock: created only if there is none, so of two servers started
 * at the same moment one fails to create it, finds the other's, and stops.
 *
 * Throws `HomeHeldError` when a running server holds the home.
 *
 * A record a crash left behind is written over in one step. Two servers that both find
 * the same one each write over it, and the later write stays: the earlier server sees
 * that when it looks again (`holdsHome`), which it does once it listens and before every
 * write, and stops.
 */
export function claimHome(): void {
  mkdirSync(akapenHome(), { recursive: true });
  // Written beside it and linked into place: the record appears whole or not at all, so
  // nobody reads one that exists and is still empty, and takes it for a broken one.
  const whole = `${servePath()}.${process.pid}.claim`;
  writeFileSync(whole, ownRecord());
  try {
    linkSync(whole, servePath());
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    rmSync(whole, { force: true });
  }
  const rec = parseServeRecord(readServeText());
  // A record naming this very pid was left by an earlier process that had it (a container
  // starts its server on the same pid every time): it cannot be another server running now.
  if (rec !== null && rec.pid !== null && rec.pid !== process.pid && recordLives(rec))
    throw new HomeHeldError({ pid: rec.pid, port: rec.port });
  writeAtomic(servePath(), ownRecord());
}

/** Whether the record still names this process: the home is this server's to write. */
export function holdsHome(): boolean {
  const rec = parseServeRecord(readServeText());
  if (rec === null || rec.pid !== process.pid) return false;
  // A reading that fails now and then must not stop a server whose record nobody replaced:
  // only a record known to name another process is somebody else's.
  const identity = rec.identity === null ? null : processIdentity(process.pid);
  return identity === null || identity === rec.identity;
}

/** Give the home up on the way out. Not another server's record, if it took the home meanwhile. */
export function releaseHome(): void {
  if (holdsHome()) rmSync(servePath(), { force: true });
}

/**
 * Whether the server this home recorded is still running. A record a crash left behind
 * names a port anyone may hold now. A pid answering EPERM belongs to another user, which a
 * server of this home never is, so it counts as gone. So does a pid that lives but is not
 * the process the record names: the server's id, given to a later process.
 */
export function recordedServerAlive(): boolean {
  return liveServeRecord() !== null;
}

/** The recorded port, read once with the pid it was checked against. */
function liveServeRecord(): number | null {
  const rec = readServeRecord();
  return rec !== null && recordLives(rec) ? rec.port : null;
}

/**
 * The port of `akapen serve` that this home may hand its management secret to: one named by
 * `$AKAPEN_PORT`, else one its running server recorded. Never the bare default, which
 * another user on the machine could be listening on.
 */
export function chosenServePort(): number | null {
  // Decimal digits only, as the CLI reads it: `1e3` is not a port.
  const given = process.env['AKAPEN_PORT'] ?? '';
  const asked = /^\d{1,5}$/.test(given) ? Number(given) : Number.NaN;
  if (asked > 0 && asked <= 65_535) return asked;
  return liveServeRecord();
}

export function writeServePort(port: number): void {
  mkdirSync(akapenHome(), { recursive: true });
  writeAtomic(servePath(), ownRecord(port));
}

/**
 * Who registered a document last, kept in its store (#305).
 *
 * The registration itself is removed when the session ends; this is what is left for
 * `akapen restore` to find when the same session is resumed. It lives beside the
 * comments, which outlive any registration, rather than in `documents.json`, which only
 * holds what is being served.
 */
export type Registration = { file: string; session: string; root?: string; addedAt?: string };

const registrationFile = (file: string): string => join(storeDir(resolve(file)), 'registration.json');

export function writeRegistration(reg: Registration): void {
  mkdirSync(storeDir(reg.file), { recursive: true });
  writeAtomic(registrationFile(reg.file), `${JSON.stringify(reg, null, 2)}\n`);
}

/** Forget who registered a document, so `akapen restore` leaves it out. */
export function forgetRegistration(file: string): void {
  rmSync(registrationFile(file), { force: true });
}

/** Every document whose last registration was made by `session`. A store that cannot be read is skipped. */
export function registrationsOf(session: string): Registration[] {
  const root = commentsRoot();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (err) {
    // No store yet is nothing to restore; one that cannot be read is a failed restore.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Registration[] = [];
  for (const name of names) {
    try {
      const reg = JSON.parse(readFileSync(join(root, name, 'registration.json'), 'utf8')) as Registration;
      if (reg.session === session && typeof reg.file === 'string') out.push(reg);
    } catch {
      /* No registration recorded for this store, or one that cannot be read. */
    }
  }
  return out;
}

/**
 * The header `akapen serve` puts on every answer of its own, refusals and errors included
 * (not on what the runtime answers before a request reaches it), and nothing else does.
 * It is how a client tells the server from whatever else may hold its port (#320): a
 * one-document akapen of an earlier version answers `/api/documents` with the very same 401.
 */
export const SERVE_MARKER = 'x-akapen-serve';

/**
 * What listens on a port of this machine: `akapen serve`, something else, or nothing.
 *
 * Asked without a credential, so that neither the token nor the management secret goes to
 * a listener that is not the server. It guards against accident, not against a listener
 * that sets the header: which port the management secret may go to at all is decided before
 * this, by who chose the port, and the token goes to the default port as it always has.
 */
export async function whatAnswers(port: number): Promise<'serve' | 'other' | 'nothing'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/documents`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
    });
    const answers = res.headers.get(SERVE_MARKER) === '1' ? 'serve' : 'other';
    // The headers have said it; a body that does not cancel cleanly changes nothing.
    await res.body?.cancel().catch(() => {});
    return answers;
  } catch {
    return 'nothing';
  }
}
