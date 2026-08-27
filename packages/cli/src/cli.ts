#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '@akapen/server';
import { AdvertiseError, localAddresses, resolveAdvertised, urlsFor } from '@akapen/core/addresses';

import { loadReview, pendingComments } from '@akapen/core/store';
import { liveInstances } from '@akapen/core/instances';
import { liveEntries, sweep as sweepSessions } from '@akapen/core/sessions';
import { currentToken, resolveToken, rotateToken, secureHome, tokenIsPinned } from '@akapen/core/token';
import { parseArgs, resolvePort, UsageError, type Args } from './args.ts';

const USAGE = `akapen — markdown inline review (PoC)

  akapen <file.md> [options]     start the review server
  akapen comments <file.md>      print unresolved comments as JSON (for agents)
  akapen list                    print the akapen running on this host
  akapen token                   print this host's token (--rotate to replace it)

options:
  --host <addr>            listen address (default 127.0.0.1)
  -p, --port <n>           port (default 4300)
  -A, --advertise <addr>   address to print in the URL, or an interface to take one
                           from ($AKAPEN_ADVERTISE sets it once per host)
  --css <file>             extra stylesheet to load
  --keymap <file>          JSON overriding the keymap ({ "action": ["key"] })
  --author <name>          comment author (default $USER)
  --token <s>              use this token instead of the stored one
  --no-auth                serve with no token at all (only behind something that authenticates)
  --all                    comments: include resolved ones
  --json                   list: print as JSON (for agents)
  --session <id>           list: only what that session started
  --rotate                 token: replace the stored token
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

/**
 * The instances running for this user, printed.
 *
 * The terminal is where you are when you have lost the port, and this is the same
 * registry the switcher in the browser reads. Only instances that answer are listed:
 * a crashed one leaves its entry behind, and pids are reused.
 *
 * Unlike the switcher, this prints the path in full. It is read on the host itself by
 * the person who started them, not handed to whoever can reach the LAN.
 */
/**
 * The token, for a script that has to present one.
 *
 * `akapen comments` reads the store off disk and needs nothing, but the reply and
 * resolve endpoints are HTTP, and so is anything watching `/api/status`. Printing it
 * from the command keeps the path out of scripts, which is the part that moves.
 *
 * `--rotate` is the only revocation there is. One secret is shared by every browser and
 * every script on this host, so replacing it locks all of them out at once — that is
 * what a shared secret costs, and there is nothing finer-grained to reach for.
 */
if (positional[0] === 'token') {
  console.log(args.rotate ? rotateToken() : resolveToken());
  process.exit(0);
}

if (positional[0] === 'list') {
  // `currentToken`, not `resolveToken`: listing is a read, and a read that generates and
  // stores a secret as a side effect is a surprise. An instance running on a token this
  // caller does not have simply does not answer, and reads as not running.
  const all = await liveInstances({ token: currentToken() });
  /**
   * Only what one session started.
   *
   * The filter is on the registry rather than on `sessions/`, because the registry is
   * where liveness is decided and `sessions/` is a reverse index for a reader that
   * cannot afford to ask. Two answers to "is it running" is one too many.
   */
  const live = args.session === undefined ? all : all.filter((e) => e.record.origin?.id === args.session);
  // Reading the registry is the other half of the sweep's rule, and `list` has just
  // done it. Not `all`: an instance that did not answer may simply be busy, and the
  // registry keeps it for that reason — deleting its url here would contradict that.
  sweepSessions(liveEntries());
  // Read once for the whole table rather than per row: every instance is on this host,
  // so the answer is the same for all of them and the routing table is a file read.
  const addresses = localAddresses();
  // What a peer advertised for itself is not in the registry — it is derived here from
  // what it bound. Recording the URL it actually printed is #99.
  const urlOf = (record: { host: string; port: number }): string =>
    urlsFor(record.host, record.port, addresses)[0];
  if (args.json) {
    console.log(
      JSON.stringify(
        live.map(({ record, status }) => ({
          pid: record.pid,
          host: record.host,
          port: record.port,
          url: urlOf(record),
          // The whole record, so `jq '.[] | select(.origin.id == "…")'` needs nothing
          // this command did not already know. Null for an entry written before origins
          // existed, or by a shell with no session to name.
          origin: record.origin ?? null,
          file: record.file,
          round: status.round,
          unresolved: status.unresolved,
          started_at: record.startedAt,
        })),
        null,
        2,
      ),
    );
    process.exit(0);
  }
  if (live.length === 0) {
    console.log(args.session === undefined ? 'no akapen is running' : 'that session has none running');
    process.exit(0);
  }
  const rows = live.map(({ record, status }) => ({
    pid: String(record.pid),
    // Enough of the id to tell five apart, which is what the column is for. The whole of
    // it is in `--json`, for anything that has to match rather than read.
    session: record.origin?.id?.slice(0, 8) ?? '-',
    // The bind address is what the registry holds, and `0.0.0.0:4300` is not somewhere
    // to go. The column is the URL for the same reason the startup line is.
    url: urlOf(record),
    round: `R${String(status.round).padStart(3, '0')}`,
    unresolved: String(status.unresolved),
    file: record.file,
  }));
  // Widths come from the rows themselves. A fixed width either wraps a long path or
  // leaves a gap wide enough that the columns stop reading as columns.
  const width = (pick: (r: (typeof rows)[number]) => string, head: string) =>
    Math.max(head.length, ...rows.map((r) => pick(r).length));
  const w = {
    pid: width((r) => r.pid, 'PID'),
    session: width((r) => r.session, 'SESSION'),
    url: width((r) => r.url, 'URL'),
    round: width((r) => r.round, 'ROUND'),
    unresolved: width((r) => r.unresolved, 'UNRESOLVED'),
  };
  console.log(
    `${'PID'.padEnd(w.pid)}  ${'SESSION'.padEnd(w.session)}  ${'URL'.padEnd(w.url)}  ${'ROUND'.padEnd(w.round)}  ${'UNRESOLVED'.padEnd(w.unresolved)}  FILE`,
  );
  for (const r of rows) {
    console.log(
      `${r.pid.padEnd(w.pid)}  ${r.session.padEnd(w.session)}  ${r.url.padEnd(w.url)}  ${r.round.padEnd(w.round)}  ${r.unresolved.padEnd(w.unresolved)}  ${r.file}`,
    );
  }
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
        // The agent's own replies are noise to it, but a person's reply to one is new
        // feedback — "could not fix, because X" answered with "then do Y instead". Y
        // only arrives if the thread comes with the comment.
        replies: (c.replies ?? []).map((r) => ({
          id: r.id,
          body: r.body,
          author: r.author,
          author_kind: r.authorKind,
          created_at: r.createdAt,
        })),
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

/**
 * `--advertise` / `-A`, or `AKAPEN_ADVERTISE` for a host that always wants the same one.
 *
 * Resolved before the socket is bound, so a value this server would refuse costs a
 * message rather than a review that is running and cannot be opened.
 *
 * The flag beats the environment. The variable is set once per host, so reaching for the
 * flag is what says this invocation is the exception — the other way round would mean
 * the exception could only be expressed by unsetting something.
 *
 * An empty variable is an unset one. `AKAPEN_ADVERTISE=` in a profile that builds it
 * conditionally is far more likely than somebody asking to advertise nothing, and the
 * flag form of the same mistake is already refused by parseArgs.
 */
let advertised: string | null = null;
const requestedAdvertise = args.advertise ?? process.env['AKAPEN_ADVERTISE'] ?? '';
if (requestedAdvertise !== '') {
  try {
    advertised = resolveAdvertised(requestedAdvertise, host);
  } catch (err) {
    if (!(err instanceof AdvertiseError)) throw err;
    fail(err.message);
  }
}

/**
 * Authentication is on at every bind address, loopback included.
 *
 * Deciding it from the bind address would make the rule depend on the one flag people
 * forget they typed, and `127.0.0.1` is not the private thing it looks like anyway — a
 * page in the reader's own browser can reach it. `--no-auth` is the way out, for when
 * something in front is already doing this job.
 */
// Before anything is written into it, and whether or not a token is generated: the
// reviews and the registry live in the same directory and are nobody else's business.
secureHome();

const token = args['no-auth'] ? null : resolveToken(args.token);

const { server, stop, storeDir, round } = startServer({
  file,
  host,
  port,
  token,
  tokenPinned: tokenIsPinned(args.token),
  author: args.author ?? process.env['USER'] ?? 'user',
  advertised,
  // exactOptionalPropertyTypes: `?:` means "may be absent", not "may be undefined".
  // With no value given, drop the key entirely.
  ...(args.css ? { cssPath: resolve(args.css) } : {}),
  ...(args.keymap ? { keymapPath: resolve(args.keymap) } : {}),
});

/**
 * Take the registry entry with us. `stop()` removes it, and without this a Ctrl-C —
 * the normal way this ends — would leave an entry pointing at a closed port, which
 * every reader then spends a timeout discovering.
 *
 * Handling the signal replaces the default action, so the exit is explicit. The usual
 * 128 + signal number is kept, since a shell reads it that way.
 */
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(code));
  });
}

/**
 * The addresses this server can be reached at, the likeliest one first.
 *
 * The bound address is not always somewhere a browser can go. `0.0.0.0` and `::` name
 * every interface rather than any one of them, and since the server refuses a `Host` it
 * does not serve, printing one back yields a 403 rather than merely an odd-looking URL.
 *
 * `server.port` is what the OS chose for `-p 0`; Bun only leaves it unset when serving
 * on a unix socket, which nothing here does, so the requested port is the fallback.
 */
// A pinned address stands in for the bind, rather than being offered alongside it.
// Passing it as the list instead would have been dropped for a concrete bind, where
// `urlsFor` prints what it was bound to and never looks at the addresses — so
// `--host 127.0.0.1 -A localhost` printed `127.0.0.1` and the flag did nothing.
// It can never be a wildcard: it came out of the served set, and no wildcard is in it.
const [primary, ...alternates] = urlsFor(advertised ?? host, server.port ?? port);

/**
 * The token is in the URL so that opening it is the whole of logging in. The redirect
 * takes it back out of the address bar, and the cookie left behind means every later
 * visit is the bare URL — so this line is also the one worth bookmarking.
 *
 * Encoded because a generated token is base64url but one handed in through `--token` or
 * `AKAPEN_TOKEN` is any string at all, and a `&` in it would print a URL that cannot be
 * used. The server reads the parameter decoded, so the two ends agree.
 *
 * Every address gets it, not just the first: an `also` line is handed over for the same
 * reason the first one is, and one without the token is a 401 for whoever receives it.
 */
const withToken = (base: string): string =>
  token === null ? base : `${base}/?token=${encodeURIComponent(token)}`;

console.log(`akapen  ${resolve(file)}`);
console.log(`  url     ${withToken(primary)}`);
// The same server, reached another way. Which one works is knowledge the reader has
// and this process does not, so all of them are offered rather than one guessed at.
// Nothing is printed here when `--advertise` named one: the choice has been made.
for (const also of alternates) console.log(`  also    ${withToken(also)}`);
console.log(`  round   ${String(round).padStart(3, '0')}`);
console.log(`  store   ${storeDir}`);
if (token === null) {
  console.log(`  note    --no-auth: anyone who can reach this address can read and write.`);
}
