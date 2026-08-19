/**
 * The shared secret, at the point where it is created and where it is compared.
 *
 * Two things here are worth breaking a test over. A token that is regenerated when it
 * should have been read makes every bookmark on the host stop working, silently, at a
 * moment nobody connects to a restart. And a token file readable by anyone on the host
 * is the whole credential handed over — the review is one `cat` away, and nothing about
 * the running server would look wrong.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentToken, readToken, resolveToken, rotateToken, tokenPath, tokensMatch } from '../src/token.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'akapen-token-'));
  process.env['AKAPEN_HOME'] = home;
  delete process.env['AKAPEN_TOKEN'];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env['AKAPEN_HOME'];
  delete process.env['AKAPEN_TOKEN'];
});

describe('the stored token', () => {
  it('is generated once and read back every time after', () => {
    const first = resolveToken();
    expect(first.length).toBeGreaterThan(20);
    // The whole reason it is on disk: a restart must not invalidate the bookmark.
    expect(resolveToken()).toBe(first);
    expect(readToken()).toBe(first);
  });

  it('is written where nobody else on the host can read it', () => {
    resolveToken();
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it('is replaced by a rotation, and only by a rotation', () => {
    const before = resolveToken();
    const after = rotateToken();
    expect(after).not.toBe(before);
    expect(readToken()).toBe(after);
    // Rotation is the only revocation there is, so it has to be the only thing that
    // moves it: a plain start that quietly rotated would lock out every other instance.
    expect(resolveToken()).toBe(after);
  });

  it('reads an empty or blank file as no token at all', () => {
    // An empty string compared with an empty string matches, so a truncated write must
    // never become the token — that is "everyone is authenticated" with no error anywhere.
    for (const junk of ['', '   ', '\n']) {
      writeFileSync(tokenPath(), junk);
      expect(readToken()).toBeNull();
    }
  });
});

describe('where the token comes from', () => {
  it('prefers the explicit one, and never writes it down', () => {
    process.env['AKAPEN_TOKEN'] = 'from-the-environment';
    expect(resolveToken('from-the-flag')).toBe('from-the-flag');
    // Persisting it would quietly make somebody else's token this host's token for
    // every later run, including runs that never passed the flag.
    expect(readToken()).toBeNull();
  });

  it('prefers the environment over the stored one, and leaves the stored one alone', () => {
    const stored = resolveToken();
    process.env['AKAPEN_TOKEN'] = 'from-the-environment';
    expect(resolveToken()).toBe('from-the-environment');
    expect(readToken()).toBe(stored);
  });

  it('never creates one just because somebody asked what it is', () => {
    // `akapen list` reads this. A read that leaves a new secret behind is a surprise,
    // and on a host with no akapen running it would be a file created for nothing.
    expect(currentToken()).toBeNull();
    expect(readToken()).toBeNull();

    process.env['AKAPEN_TOKEN'] = 'handed-in';
    expect(currentToken()).toBe('handed-in');
    expect(readToken()).toBeNull();
  });
});

describe('comparing a presented token', () => {
  it('accepts the real one and refuses everything else', () => {
    const real = resolveToken();
    expect(tokensMatch(real, real)).toBe(true);
    expect(tokensMatch(`${real}x`, real)).toBe(false);
    expect(tokensMatch(real.slice(0, -1), real)).toBe(false);
    expect(tokensMatch('', real)).toBe(false);
  });

  it('answers a token of any length instead of throwing', () => {
    // The comparison is over two digests, so length never reaches the primitive that
    // rejects mismatched buffers. A guard on length would also answer "wrong length"
    // faster than "wrong contents", which is the leak this is written to avoid.
    const real = resolveToken();
    expect(() => tokensMatch('x', real)).not.toThrow();
    expect(() => tokensMatch('x'.repeat(5_000), real)).not.toThrow();
    expect(tokensMatch('x'.repeat(5_000), real)).toBe(false);
  });
});
