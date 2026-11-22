/**
 * The shared secret, at the point where it is created and where it is compared.
 *
 * Two things here are worth breaking a test over. A token that is regenerated when it
 * should have been read makes every bookmark on the host stop working, silently, at a
 * moment nobody connects to a restart. And a token file readable by anyone on the host
 * is the whole credential handed over — the review is one `cat` away, and nothing about
 * the running server would look wrong.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentToken,
  generate,
  ManageTokenError,
  readManageToken,
  resolveManageToken,
  secretFileFault,
  readToken,
  resolveToken,
  rotateToken,
  secureHome,
  tokenPath,
  tokensMatch,
} from '../src/token.ts';

let sandbox: string;
let home: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'akapen-token-'));
  // A directory the code under test has to create for itself. Pointing AKAPEN_HOME at
  // the mkdtemp directory instead would make the mode assertion below meaningless:
  // mkdtemp always creates 0700, so it would pass whatever mode writeToken asked for.
  home = join(sandbox, 'home');
  process.env['AKAPEN_HOME'] = home;
  delete process.env['AKAPEN_TOKEN'];
  delete process.env['AKAPEN_MANAGE_TOKEN'];
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env['AKAPEN_HOME'];
  delete process.env['AKAPEN_TOKEN'];
});

describe('the stored token', () => {
  it('never starts with a dash, so it can be handed back through --token', () => {
    // base64url includes `-`, and a value beginning with one is read as an option in the
    // space-separated form. One token in sixty-four would come out of `akapen token` and
    // fail to go back in. Drawn with `generate`, since `rotateToken` writes the file and is
    // too slow to repeat. A generator that let a dash through passes 2000 draws with odds
    // of about 2e-14; the one `rotateToken` below only shows it still answers.
    for (let i = 0; i < 2000; i++) {
      expect(generate().startsWith('-')).toBe(false);
    }
    expect(rotateToken().startsWith('-')).toBe(false);
  });

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

  it('tightens the home directory even when no token is ever written', () => {
    // A run given its token through `--token` or `AKAPEN_TOKEN` never calls `writeToken`,
    // and the reviews and the instance registry are in that directory just the same.
    mkdirSync(home, { recursive: true, mode: 0o755 });
    secureHome();
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it('tightens a home directory something else created loosely', () => {
    // The usual case, not the fresh one: the review store and the instance registry both
    // make `~/.akapen` before a token is ever written, and neither asks for a mode. The
    // directory is then 0755, and `mkdirSync` will not change it — it only applies a mode
    // to a directory it creates.
    mkdirSync(home, { recursive: true, mode: 0o755 });
    expect(statSync(home).mode & 0o777).toBe(0o755);

    resolveToken();
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
    // The directory has to exist before writing straight into it; nothing has created
    // it yet in this test, since `resolveToken` is what normally would.
    mkdirSync(home, { recursive: true });
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

describe('the stored management secret', () => {
  const stored = () => join(home, 'manage-token');
  const store = (mode: number) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(stored(), 'kept-management-value\n');
    // Not the mode option of the write: the umask would take bits off it.
    chmodSync(stored(), mode);
  };

  it('is read from a file only its owner can read', () => {
    store(0o600);
    expect(readManageToken()).toBe('kept-management-value');
    expect(resolveManageToken()).toBe('kept-management-value');
  });

  it.each([0o644, 0o640, 0o604, 0o620, 0o602])('is not read from a file of mode %o', (mode) => {
    store(mode);
    expect(readManageToken()).toBeNull();
  });

  it('does not start a server on a new secret in place of one others could read', () => {
    store(0o644);
    expect(() => resolveManageToken()).toThrow(ManageTokenError);
    expect(() => resolveManageToken()).toThrow('its mode is 644, not 600');
    expect(readFileSync(stored(), 'utf8')).toBe('kept-management-value\n');
    expect(statSync(stored()).mode & 0o777).toBe(0o644);
  });

  it('takes AKAPEN_MANAGE_TOKEN whatever the file is like', () => {
    store(0o644);
    process.env['AKAPEN_MANAGE_TOKEN'] = 'handed-in-value';
    try {
      expect(readManageToken()).toBe('handed-in-value');
      expect(resolveManageToken()).toBe('handed-in-value');
    } finally {
      delete process.env['AKAPEN_MANAGE_TOKEN'];
    }
  });

  it('faults a file that belongs to another user, and no other sound one', () => {
    expect(secretFileFault({ mode: 0o100600, uid: 1000 }, 1000)).toBeNull();
    expect(secretFileFault({ mode: 0o100400, uid: 1000 }, 1000)).toBeNull();
    expect(secretFileFault({ mode: 0o100600, uid: 1001 }, 1000)).toBe('it belongs to uid 1001, not 1000');
    expect(secretFileFault({ mode: 0o100600, uid: 0 }, 1000)).toBe('it belongs to uid 0, not 1000');
  });

  it('says why once, however often the secret is asked for', async () => {
    store(0o644);
    vi.resetModules();
    const fresh = await import('../src/token.ts');
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(fresh.readManageToken()).toBeNull();
      expect(fresh.readManageToken()).toBeNull();
      expect(said.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining(`${stored()} is not used: its mode is 644, not 600`),
      ]);
    } finally {
      said.mockRestore();
    }
  });

  it('reads nothing where the secret cannot be looked at, and does not write a new one over it', () => {
    // A home that is a file: the path cannot be opened, for a reason other than not being there.
    writeFileSync(home, '');
    expect(readManageToken()).toBeNull();
    expect(() => resolveManageToken()).toThrow(ManageTokenError);
    expect(() => resolveManageToken()).toThrow('it cannot be opened (ENOTDIR)');
    rmSync(home);
    // A directory where the secret would be, sound by mode and owner, so it is the read that fails.
    mkdirSync(stored(), { recursive: true });
    chmodSync(stored(), 0o700);
    expect(readManageToken()).toBeNull();
    expect(() => resolveManageToken()).toThrow('it cannot be read (EISDIR)');
    expect(statSync(stored()).isDirectory()).toBe(true);
  });

  it('writes one where there is none', () => {
    const created = resolveManageToken();
    expect(readFileSync(stored(), 'utf8')).toBe(created);
    expect(statSync(stored()).mode & 0o777).toBe(0o600);
  });
});
