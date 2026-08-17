/**
 * Command line parsing.
 *
 * Separate from cli.ts because cli.ts runs on import — it reads argv, starts a server
 * and exits. Nothing can exercise the parsing while it lives there, which is how
 * `--css` with no value shipped as `resolve(true)`.
 *
 * The rule this file exists to enforce: a flag that needs a value never yields a
 * boolean. Missing values fail here, with the name of the flag, instead of turning into
 * a TypeError somewhere else or a server listening on `true`.
 */

/** Thrown for anything the caller typed wrong. cli.ts prints it with the usage text. */
export class UsageError extends Error {}

/** Flags that carry a value. Given without one, they fail rather than becoming `true`. */
const VALUE_FLAGS = ['host', 'port', 'css', 'keymap', 'author'] as const;

/** Flags that are on or off. Given a value, they fail — `--all=false` reads as "off". */
const BOOLEAN_FLAGS = ['help', 'all', 'restore'] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];
type BooleanFlag = (typeof BOOLEAN_FLAGS)[number];

export type Args = {
  /** Everything that is not a flag: the subcommand and the file. */
  positional: string[];
} & { [K in ValueFlag]?: string } & { [K in BooleanFlag]: boolean };

const isValueFlag = (name: string): name is ValueFlag => (VALUE_FLAGS as readonly string[]).includes(name);
const isBooleanFlag = (name: string): name is BooleanFlag =>
  (BOOLEAN_FLAGS as readonly string[]).includes(name);

/** Both forms of "no value given": absent, empty, or the next flag. */
const missing = (value: string | undefined): boolean =>
  value === undefined || value === '' || value.startsWith('-');

/**
 * A value may be attached (`--host=x`) or be the next argument (`--host x`).
 *
 * A next argument starting with `-` is not taken as the value. `--author --all` is far
 * more likely to be a forgotten name than an author called `--all`, and swallowing the
 * next flag hides two mistakes at once. Values that really do start with a dash go
 * through the attached form.
 *
 * The two forms answer the same way. `--css=` and `--css ""` are the same mistake, and
 * an empty one that got through would be dropped later by a truthiness check — silently,
 * which is the failure this file exists to remove.
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], help: false, all: false, restore: false };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '-p' || token === '--port') {
      const next = argv[i + 1];
      if (missing(next)) throw new UsageError(`${token} needs a value`);
      args.port = next!;
      i++;
      continue;
    }

    if (!token.startsWith('--')) {
      // `-p` is matched whole, above. Anything else that starts with a dash is meant as
      // an option, so it cannot be filed as a file name: `akapen note.md -p4300` would
      // otherwise start on the default port with the one that was asked for ignored,
      // and `akapen -p4300 note.md` would report "no such file: -p4300".
      if (token.startsWith('-') && token !== '-') {
        throw new UsageError(`unknown option: ${token} (values are separate: -p 4300)`);
      }
      args.positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    const attached = eq === -1 ? undefined : body.slice(eq + 1);

    if (isBooleanFlag(name)) {
      if (attached !== undefined) throw new UsageError(`--${name} takes no value`);
      args[name] = true;
      continue;
    }

    if (!isValueFlag(name)) {
      // Enumerating the flags is what makes the missing-value check possible, and once
      // they are enumerated an unknown one can only be a typo. Accepting it silently is
      // the same failure this file exists to remove: `--kemap` would do nothing at all.
      throw new UsageError(`unknown option: --${name}`);
    }

    if (attached !== undefined) {
      if (attached === '') throw new UsageError(`--${name} needs a value`);
      args[name] = attached;
      continue;
    }

    const next = argv[i + 1];
    if (missing(next)) throw new UsageError(`--${name} needs a value`);
    args[name] = next!;
    i++;
  }

  return args;
}

/**
 * Port 0 is allowed and means "let the OS pick" — the server tests rely on it, and it
 * is the only way to start akapen without guessing at what is already listening.
 */
export function resolvePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  // The shape is checked before the conversion. Number('') and Number(' ') are both 0,
  // which is a legal port, so `--port ''` would silently listen on an OS-chosen one.
  // Number also accepts '0x10' and '1e3', which nobody typing a port means.
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new UsageError(`--port must be a whole number between 0 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}
