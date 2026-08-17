/**
 * Command line parsing.
 *
 * The failure this guards against is quiet. A flag given without its value used to
 * become `true`, and nothing said so: `--css` threw a TypeError from `resolve(true)`,
 * `--host` listened on the string "true", and `--author` credited every comment to
 * "true". The parser is a separate module so these can be run at all.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureRound, makeComment, saveComments } from '@akapen/core/store';
import { parseArgs, resolvePort, UsageError } from '../src/args.ts';

describe('positional arguments', () => {
  it('collects the subcommand and the file', () => {
    expect(parseArgs(['comments', 'note.md']).positional).toEqual(['comments', 'note.md']);
  });

  it('defaults every boolean flag to off', () => {
    const args = parseArgs(['note.md']);
    expect(args.help).toBe(false);
    expect(args.all).toBe(false);
  });
});

describe('flags that take a value', () => {
  it('reads the value from the next argument', () => {
    const args = parseArgs(['note.md', '--host', '0.0.0.0', '--author', 'someone']);
    expect(args.host).toBe('0.0.0.0');
    expect(args.author).toBe('someone');
  });

  it('reads the value attached with =', () => {
    expect(parseArgs(['note.md', '--host=0.0.0.0']).host).toBe('0.0.0.0');
  });

  it('takes a value starting with a dash only in the attached form', () => {
    // `--author --all` is a forgotten name far more often than an author called --all,
    // and swallowing the next flag would hide two mistakes at once.
    expect(parseArgs(['note.md', '--author=-bob']).author).toBe('-bob');
    expect(() => parseArgs(['note.md', '--author', '--all'])).toThrow(UsageError);
  });

  it.each([
    ['at the end of the line', ['note.md', '--css']],
    ['followed by another flag', ['note.md', '--css', '--all']],
    ['attached but empty', ['note.md', '--css=']],
    // The separated form has to answer the same way. An empty value that got through
    // would be dropped later by a truthiness check, without a word.
    ['separated but empty', ['note.md', '--css', '']],
  ])('refuses a value flag %s', (_label, argv) => {
    // This is the whole point: `true` must never reach resolve(), a listen address or
    // a comment author.
    expect(() => parseArgs(argv)).toThrow(/--css needs a value/);
  });

  it('refuses -p and --port without a value', () => {
    expect(() => parseArgs(['note.md', '-p'])).toThrow(/-p needs a value/);
    expect(() => parseArgs(['note.md', '--port'])).toThrow(/--port needs a value/);
    expect(() => parseArgs(['note.md', '-p', ''])).toThrow(/-p needs a value/);
    // `-p --host 0.0.0.0` used to store "--host" as the port and reach Number() as NaN.
    expect(() => parseArgs(['note.md', '-p', '--host', '0.0.0.0'])).toThrow(UsageError);
  });

  it('accepts -p and --port as the same flag', () => {
    expect(parseArgs(['note.md', '-p', '4300']).port).toBe('4300');
    expect(parseArgs(['note.md', '--port', '4300']).port).toBe('4300');
    expect(parseArgs(['note.md', '--port=4300']).port).toBe('4300');
  });
});

describe('flags that are on or off', () => {
  it('turns on when present', () => {
    expect(parseArgs(['comments', 'note.md', '--all']).all).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('refuses a value, because --all=false would read as off and be on', () => {
    expect(() => parseArgs(['comments', 'note.md', '--all=false'])).toThrow(/--all takes no value/);
  });
});

describe('unknown flags', () => {
  it('are refused rather than ignored', () => {
    // Enumerating the flags is what makes the missing-value check possible; once they
    // are enumerated, an unknown one can only be a typo. `--kemap` did nothing at all.
    expect(() => parseArgs(['note.md', '--kemap', 'k.json'])).toThrow(/unknown option: --kemap/);
  });

  it.each([['-p4300'], ['-p=4300'], ['-x']])('refuses %s instead of filing it as a file name', (token) => {
    // Only `-p` matched whole was recognised, so these fell through to the positional
    // list: `note.md -p4300` started on the default port with the asked-for one gone,
    // and `-p4300 note.md` reported "no such file: -p4300".
    expect(() => parseArgs(['note.md', token])).toThrow(/unknown option/);
    expect(() => parseArgs([token, 'note.md'])).toThrow(/unknown option/);
  });

  it('still takes a lone dash as positional, since it is not an option', () => {
    expect(parseArgs(['-']).positional).toEqual(['-']);
  });
});

describe('resolvePort', () => {
  it('falls back when the flag is absent', () => {
    expect(resolvePort(undefined, 4300)).toBe(4300);
  });

  it('allows 0, which asks the OS to pick', () => {
    expect(resolvePort('0', 4300)).toBe(0);
  });

  it.each([['abc'], ['4300.5'], ['65536'], ['']])('refuses %o', (raw) => {
    expect(() => resolvePort(raw, 4300)).toThrow(UsageError);
  });
});

describe('the binary', () => {
  const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

  /**
   * Run the real entry point: the parser is only useful if cli.ts acts on it.
   *
   * Bounded, because the failure mode being tested is "it starts a server instead of
   * refusing". Without a timeout a regression would hang here until the whole run gives
   * up, and SIGKILL because a listening server need not honour SIGTERM promptly.
   */
  const run = (args: string[]) =>
    spawnSync('bun', ['run', CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 10_000,
      killSignal: 'SIGKILL',
    });

  it('exits non-zero and names the flag instead of starting a server', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-cli-'));
    const note = join(sandbox, 'note.md');
    writeFileSync(note, '# Heading\n');
    try {
      const missing = run([note, '--css']);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/--css needs a value/);

      const badPort = run([note, '--port', 'abc']);
      expect(badPort.status).toBe(1);
      expect(badPort.stderr).toMatch(/--port must be a whole number/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('the delete subcommand', () => {
  const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (args: string[], home: string) =>
    spawnSync('bun', ['run', CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AKAPEN_HOME: home },
      timeout: 20_000,
      killSignal: 'SIGKILL',
    });

  it('withdraws a comment and takes it out of the agent handoff, without a server', () => {
    // The store is a plain sidecar, so this has to work with nothing listening.
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-cli-del-'));
    const home = join(sandbox, 'home');
    const note = join(sandbox, 'note.md');
    writeFileSync(note, '# Heading\n\nA paragraph.\n');
    try {
      process.env['AKAPEN_HOME'] = home;
      ensureRound(note, readFileSync(note, 'utf8'));
      const c = makeComment(readFileSync(note, 'utf8'), 1, 1, 'typo', 't');
      saveComments(note, 1, [c]);
      delete process.env['AKAPEN_HOME'];

      const listed = run(['comments', note], home);
      expect(JSON.parse(listed.stdout)).toHaveLength(1);

      const del = run(['delete', note, c.id], home);
      expect(del.status).toBe(0);
      expect(del.stdout).toContain(`deleted ${c.id}`);
      expect(JSON.parse(run(['comments', note], home).stdout)).toHaveLength(0);
      // Even with --all: withdrawn is not the same as resolved.
      expect(JSON.parse(run(['comments', note, '--all'], home).stdout)).toHaveLength(0);

      const back = run(['delete', note, c.id, '--restore'], home);
      expect(back.status).toBe(0);
      expect(back.stdout).toContain(`restored ${c.id}`);
      expect(JSON.parse(run(['comments', note], home).stdout)).toHaveLength(1);
    } finally {
      delete process.env['AKAPEN_HOME'];
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  it('names the ids it could not find and exits non-zero', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'akapen-cli-del-'));
    const note = join(sandbox, 'note.md');
    writeFileSync(note, '# Heading\n');
    try {
      const res = run(['delete', note, 'c_nope'], join(sandbox, 'home'));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('no such comment: c_nope');

      const noIds = run(['delete', note], join(sandbox, 'home'));
      expect(noIds.status).toBe(1);
      expect(noIds.stderr).toContain('delete needs at least one comment id');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});
