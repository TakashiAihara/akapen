#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '@akapen/server';
import { loadReview, pendingComments } from '@akapen/core/store';

const USAGE = `akapen — markdown inline review (PoC)

  akapen <file.md> [options]     start the review server
  akapen comments <file.md>      print unresolved comments as JSON (for agents)

options:
  --host <addr>    listen address (default 127.0.0.1)
  -p, --port <n>   port (default 4300)
  --css <file>     extra stylesheet to load
  --keymap <file>  JSON overriding the keymap ({ "action": ["key"] })
  --author <name>  comment author (default $USER)
  --all            comments: include resolved ones
`;

/**
 * Name the flags we accept.
 *
 * With only an index signature, `args.port` trips noPropertyAccessFromIndexSignature
 * and everything turns into bracket notation. Listing the known flags keeps dot
 * access readable and puts the accepted set in the type.
 */
type Args = {
  _: string[];
  help?: string | boolean;
  host?: string | boolean;
  port?: string | boolean;
  css?: string | boolean;
  keymap?: string | boolean;
  author?: string | boolean;
  all?: string | boolean;
  [k: string]: string | boolean | string[] | undefined;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-p') args.port = argv[++i]!;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k!] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) args[k!] = argv[++i]!;
      else args[k!] = true;
    } else (args._ as string[]).push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const positional = args._ as string[];

if (positional.length === 0 || args.help) {
  console.log(USAGE);
  process.exit(0);
}

if (positional[0] === 'comments') {
  const file = positional[1];
  if (!file || !existsSync(file)) {
    console.error(`akapen: no such file: ${file ?? '(missing)'}`);
    process.exit(1);
  }
  // Unresolved comments from earlier rounds are included. Closing a round removes them
  // from the screen, not from the feedback. Line numbers refer to that round's snapshot
  // and will not match the live file, so an agent matches on `anchor` (the text as it was).
  const review = loadReview(file);
  const comments = pendingComments(file, Boolean(args.all));
  console.log(
    JSON.stringify(
      comments.map((c) => ({
        id: c.id,
        path: resolve(file),
        round: c.round,
        // Whether it belongs to the current round. Older ones are feedback on the document
        // as it was, so treat their line numbers as already shifted in the live file.
        current_round: c.round === review.currentRound,
        start_line: c.startLine,
        end_line: c.endLine,
        body: c.body,
        anchor: c.anchor,
        author: c.author,
        resolved: c.resolved,
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}

const file = positional[0]!;
if (!existsSync(file)) {
  console.error(`akapen: no such file: ${file}`);
  process.exit(1);
}

const host = (args.host as string) ?? '127.0.0.1';
const port = Number(args.port ?? 4300);
const { server, storeDir, round } = startServer({
  file,
  host,
  port,
  author: (args.author as string) ?? process.env['USER'] ?? 'user',
  // exactOptionalPropertyTypes: `?:` means "may be absent", not "may be undefined".
  // With no value given, drop the key entirely.
  ...(args.css ? { cssPath: resolve(args.css as string) } : {}),
  ...(args.keymap ? { keymapPath: resolve(args.keymap as string) } : {}),
});

console.log(`akapen  ${resolve(file)}`);
console.log(`  url     http://${host}:${server.port}`);
console.log(`  round   ${String(round).padStart(3, '0')}`);
console.log(`  store   ${storeDir}`);
if (host !== '127.0.0.1') console.log(`  note    no authentication. mind who can reach this address.`);
