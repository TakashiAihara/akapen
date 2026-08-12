#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '@akapen/server';
import { loadReview, pendingComments } from '@akapen/core/store';
import { parseArgs, resolvePort, UsageError, type Args } from './args.ts';

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

/** Anything typed wrong ends here: the reason, then how to type it. */
function fail(message: string): never {
  console.error(`akapen: ${message}`);
  console.error(`\n${USAGE}`);
  process.exit(1);
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  fail(err.message);
}
const positional = args.positional;

if (positional.length === 0 || args.help) {
  console.log(USAGE);
  process.exit(0);
}

if (positional[0] === 'comments') {
  const file = positional[1];
  if (!file || !existsSync(file)) fail(`no such file: ${file ?? '(missing)'}`);
  // Unresolved comments from earlier rounds are included. Closing a round removes them
  // from the screen, not from the feedback. Line numbers refer to that round's snapshot
  // and will not match the live file, so an agent matches on `anchor` (the text as it was).
  const review = loadReview(file);
  const comments = pendingComments(file, args.all);
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
if (!existsSync(file)) fail(`no such file: ${file}`);

// Every value below is a string or absent — parseArgs rejects the boolean case — so
// there is nothing left here to cast.
const host = args.host ?? '127.0.0.1';
let port: number;
try {
  port = resolvePort(args.port, 4300);
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  fail(err.message);
}

const { server, storeDir, round } = startServer({
  file,
  host,
  port,
  author: args.author ?? process.env['USER'] ?? 'user',
  // exactOptionalPropertyTypes: `?:` means "may be absent", not "may be undefined".
  // With no value given, drop the key entirely.
  ...(args.css ? { cssPath: resolve(args.css) } : {}),
  ...(args.keymap ? { keymapPath: resolve(args.keymap) } : {}),
});

console.log(`akapen  ${resolve(file)}`);
console.log(`  url     http://${host}:${server.port}`);
console.log(`  round   ${String(round).padStart(3, '0')}`);
console.log(`  store   ${storeDir}`);
if (host !== '127.0.0.1') console.log(`  note    no authentication. mind who can reach this address.`);
