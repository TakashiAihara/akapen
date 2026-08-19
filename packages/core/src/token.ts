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
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { akapenHome, writeAtomic } from './store.ts';

/** Where the token is kept. Beside the reviews, so `AKAPEN_HOME` moves both together. */
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
function generate(): string {
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
