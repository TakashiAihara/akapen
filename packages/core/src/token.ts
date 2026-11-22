/**
 * The one secret that opens this host's akapen.
 *
 * A shared secret, not a key: nothing is encrypted or signed, and holding it is the
 * whole of the authorisation. It travels on every request, which is why the transport
 * being plain HTTP is a stated limit rather than a detail (#10).
 *
 * One token per host, not per document or per port. Several akapen run at once on a
 * host (#86), and cookies are not isolated by port — RFC 6265 §8.5 — so one token means
 * opening one of them hands the browser every other one at the same time. Per-instance
 * tokens would need per-instance cookie names to avoid overwriting each other, and buy
 * a separation a single-user tool has no use for.
 *
 * It outlives the process on purpose. A token generated per run is seamless too, right
 * up until the cookie is cleared, and then the bookmark is dead and the only way back
 * in is to find a URL in a terminal somewhere.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { akapenHome, writeAtomic } from './store.ts';

/** Where the token is kept. Beside the comments, so `AKAPEN_HOME` moves both together. */
export function tokenPath(): string {
  return join(akapenHome(), 'token');
}

/**
 * 32 bytes, so guessing is not a strategy. base64url, so it survives a URL untouched.
 *
 * Never starting with `-`. base64url includes it, and a value beginning with a dash is
 * read as an option rather than a value in the space-separated form, so one token in
 * sixty-four would come back out of `akapen token` and fail to go into `--token`. The
 * attached form always works; this is so the obvious thing works too.
 */
export function generate(): string {
  for (;;) {
    const token = randomBytes(32).toString('base64url');
    if (!token.startsWith('-')) return token;
  }
}

/**
 * The stored token, or null.
 *
 * A file that exists but holds nothing usable is treated as absent rather than as an
 * empty token: an empty string compared against an empty string matches, so a truncated
 * write would otherwise turn into "everyone is authenticated".
 */
export function readToken(): string | null {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/**
 * Write the token where only this user can read it.
 *
 * The file's mode is set at creation, not after: a token written world-readable and
 * chmodded a moment later has already been readable. The directory is only tightened
 * afterwards, since it is usually not ours to create by then — a 0755 directory holding
 * a 0600 file leaks that the file exists, not what is in it.
 */
/**
 * Make `~/.akapen` ours alone.
 *
 * Everything akapen keeps is in here — the documents' rounds, every comment, which files
 * are being reviewed and by which process — and the store and the registry both create
 * the directory without asking for a mode, so it lands world-readable at the usual
 * umask. Nothing in it is meant for anyone else on the host.
 *
 * Called on every start, not only when a token is written. A run given its token through
 * `--token` or `AKAPEN_TOKEN` never writes one, and it holds the same reviews.
 *
 * `mkdirSync` applies its mode only to a directory it creates, so the chmod is not
 * redundant with the line above it.
 */
export function secureHome(): void {
  const home = akapenHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    /* Not ours to tighten. Whatever is written into it still carries its own mode. */
  }
}

export function writeToken(token: string): void {
  secureHome();
  writeAtomic(tokenPath(), token, { mode: 0o600 });
}

/**
 * The token in effect for this process, without creating one.
 *
 * `AKAPEN_TOKEN` first, then the stored one. Neither is written to disk here — a token
 * that was handed in belongs to whoever handed it in, and persisting it would silently
 * make it this host's token for every later run.
 *
 * Separate from `resolveToken` because reading is not starting. `akapen list` and
 * anything else that only wants to talk to a running instance must not leave a new
 * secret behind as a side effect of having looked.
 */
export function currentToken(): string | null {
  const given = process.env['AKAPEN_TOKEN'];
  if (given !== undefined && given !== '') return given;
  return readToken();
}

/**
 * Whether the token was chosen by the caller rather than read from the store.
 *
 * A pinned one belongs to whoever handed it in and lasts as long as the process. One
 * that came from the store does not: rotating it has to lock out the sessions that are
 * open now, which means the server has to keep looking at the file rather than at what
 * it read when it started.
 */
export function tokenIsPinned(explicit?: string): boolean {
  if (explicit !== undefined && explicit !== '') return true;
  const env = process.env['AKAPEN_TOKEN'];
  return env !== undefined && env !== '';
}

/**
 * The token this process will serve with, generating and storing one the first time.
 *
 * `explicit` is `--token`, which wins over everything: it is the only one the caller
 * typed on purpose for this run.
 */
export function resolveToken(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const known = currentToken();
  if (known !== null) return known;
  const fresh = generate();
  writeToken(fresh);
  return fresh;
}

/** Replace the stored token. Every browser and every script holding the old one is out. */
export function rotateToken(): string {
  const fresh = generate();
  writeToken(fresh);
  return fresh;
}

/**
 * Compare a presented token with the real one without leaking how much of it was right.
 *
 * Hashed first because `timingSafeEqual` throws on lengths that differ, and guarding
 * that with an early length check would answer "wrong length" in less time than "wrong
 * contents". Two SHA-256 digests are always 32 bytes, so the comparison the attacker
 * can time is over a fixed width whatever they send.
 */
export function tokensMatch(presented: string, actual: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(actual).digest();
  return timingSafeEqual(a, b);
}

/**
 * The secret the management API of `akapen serve` asks for (#305, #306).
 *
 * Separate from the token, which every reader on the LAN holds as a cookie: registering a
 * document makes the server read a file, so whoever may register can read any file the
 * server's user can. This one stays in a 0600 file only that user can read, so the CLI on
 * the same machine has it and a request relayed by a proxy does not. `AKAPEN_MANAGE_TOKEN`
 * hands the same value to a server or a CLI that does not share this home (a container).
 */
export function manageTokenPath(): string {
  return join(akapenHome(), 'manage-token');
}

/** `AKAPEN_MANAGE_TOKEN`, handed in on purpose. Trimmed as the file is: a blank value is not a secret. */
function givenManageToken(): string | null {
  const given = process.env['AKAPEN_MANAGE_TOKEN']?.trim();
  return given === undefined || given === '' ? null : given;
}

/**
 * What is wrong with a file holding a secret, or null: a mode that lets anyone but its owner
 * read or replace it, or an owner who is not the user running this (#322).
 */
export function secretFileFault(st: { mode: number; uid: number }, uid: number): string | null {
  if ((st.mode & 0o077) !== 0) return `its mode is ${(st.mode & 0o777).toString(8)}, not 600`;
  if (st.uid !== uid) return `it belongs to uid ${st.uid}, not ${uid}`;
  return null;
}

/** The code of a file-system error, for a message. */
const errnoOf = (err: unknown): string => String((err as { code?: unknown }).code);

/**
 * The stored management secret, or why it is not used. Neither when there is none to read.
 *
 * The file lets a request register any file the server's user can read, so one that another
 * user of the machine could have read, in a shared or copied home, is not a secret any more.
 * Refused rather than tightened: a chmod would hide that it had been readable. Checked and
 * read through one descriptor, so the file that was checked is the file that is read. Not
 * checked where there are no uids to compare (Windows). What an ACL grants is not seen.
 *
 * Only a file that is not there counts as none. One that is there and cannot be opened or
 * read (another user's 0600, which this user cannot open to look at; a directory) is a
 * fault as well: taking it for none would have the server write a new secret over it.
 */
function storedManageToken(): { value: string | null; fault: string | null } {
  const path = manageTokenPath();
  const unused = (why: string) => ({
    value: null,
    fault: `${path} is not used: ${why}. Delete it and restart akapen serve, which writes a new one`,
  });
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    return errnoOf(err) === 'ENOENT'
      ? { value: null, fault: null }
      : unused(`it cannot be opened (${errnoOf(err)})`);
  }
  try {
    const fault = process.getuid === undefined ? null : secretFileFault(fstatSync(fd), process.getuid());
    if (fault !== null) return unused(`${fault}, so whoever could read it may hold the secret`);
    const raw = readFileSync(fd, 'utf8').trim();
    return { value: raw === '' ? null : raw, fault: null };
  } catch (err) {
    return unused(`it cannot be read (${errnoOf(err)})`);
  } finally {
    closeSync(fd);
  }
}

/** A stored management secret that is not used, so a server does not start on a new one without a word. */
export class ManageTokenError extends Error {}

let faultSaid = false;

export function readManageToken(): string | null {
  const given = givenManageToken();
  if (given !== null) return given;
  const stored = storedManageToken();
  // Once per process: the channel reads it on every pass.
  if (stored.fault !== null && !faultSaid) console.error(`akapen: ${stored.fault}`);
  faultSaid ||= stored.fault !== null;
  return stored.value;
}

/** The management secret for a starting server, created on the first start. */
export function resolveManageToken(): string {
  const given = givenManageToken();
  if (given !== null) return given;
  const stored = storedManageToken();
  if (stored.fault !== null) throw new ManageTokenError(stored.fault);
  if (stored.value !== null) return stored.value;
  const created = generate();
  secureHome();
  writeAtomic(manageTokenPath(), created, { mode: 0o600 });
  return created;
}
