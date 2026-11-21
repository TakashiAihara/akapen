#!/usr/bin/env bun

import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { AdvertiseError, localAddresses, resolveAdvertised, urlsFor } from '@akapen/core/addresses';

import { isInside } from '@akapen/core/files';
import { readServePort, recordedServerAlive } from '@akapen/core/documents';
import { akapenHome, loadReview, pendingComments } from '@akapen/core/store';
import { liveInstances, reachableHost, readInstances } from '@akapen/core/instances';
import { liveEntries, sweep as sweepSessions } from '@akapen/core/sessions';
import {
  currentToken,
  readManageToken,
  resolveManageToken,
  resolveToken,
  rotateToken,
  secureHome,
  tokenIsPinned,
} from '@akapen/core/token';
import { parseArgs, resolveHost, resolvePort, resolveSession, UsageError, type Args } from './args.ts';

const USAGE = `akapen — markdown inline review

  akapen serve [options]         start the server that serves every registered document
  akapen add <file.md>           register a document with that server and print its URL
                                 (--root <dir> to serve its images from a wider directory)
  akapen remove <file.md|id>     unregister a document (its comments stay;
                                 --session <id> instead: every document that session
                                 registered, for its SessionEnd hook)
  akapen restore <session-id>    register again what that session registered last,
                                 for its SessionStart hook on resume
  akapen <file.md> [options]     start a server for this one document
  akapen comments <file.md>      print unresolved comments as JSON (for agents)
  akapen reply <file.md> <id> <text>   reply to a comment (--resolve to close it too;
                                       -- before a text that starts with a dash)
  akapen resolve <file.md> <id>  resolve a comment
  akapen rounds cut <file.md>    close the current round and open the next one
                                 (none when the file matches the current round)
  akapen list                    print the akapen running on this host
  akapen channel                 push this session's comments to Claude Code (MCP channel)
  akapen token                   print this host's token (--rotate to replace it)

options:
  --host <addr>            listen address: an IP address or localhost (default 127.0.0.1)
  -p, --port <n>           port (default 4300, or one the OS picks when that is taken;
                           a port given here is never moved off. 0: let the OS pick).
                           serve: $AKAPEN_PORT or 4300, never moved off; add, remove and
                           list reach it on 127.0.0.1 at -p, $AKAPEN_PORT, the port the
                           running server recorded, or 4300
  -A, --advertise <addr>   address to print in the URL, or an interface to take one
                           from ($AKAPEN_ADVERTISE sets it once per host)
  --css <file>             extra stylesheet to load
  --keymap <file>          JSON overriding the keymap ({ "action": ["key"] })
  --root <dir>             file root: serve images the document refers to from anywhere
                           under this directory (default: the document's own directory)
  --author <name>          comment author (default $USER)
  --token <s>              use this token instead of the stored one
  --no-auth                serve with no token at all (only behind something that authenticates)
  --all                    comments: include resolved ones
  --json                   list: print as JSON (for agents)
  --session <id>           list: only what that session started (a unique prefix works)
  --rotate                 token: replace the stored token
  --resolve                reply: resolve the comment after replying
`;

/** Anything typed wrong ends here: the reason, then how to type it. */
function fail(message: string): never {
  console.error(`akapen: ${message}`);
  console.error(`\n${USAGE}`);
  process.exit(1);
}

/**
 * Where a command finds `akapen serve`: `-p`, else `$AKAPEN_PORT`, else the port the running
 * server recorded, else 4300. `serve` picks its own port without the recorded one.
 */
function daemonPort(): number | null {
  try {
    // `-p` on a command that talks to the server names the server's port, as it does on serve.
    // Then the port the running server recorded, so `serve -p <n>` alone is found too.
    const named = (portFlagNamesServer ? args?.port : undefined) ?? (process.env['AKAPEN_PORT'] || undefined);
    if (named !== undefined) return resolvePort(named, 4300);
    // The default port belongs to the default home. A server answering there for another
    // home keeps another store; one in a home set by AKAPEN_HOME is found by what it recorded.
    return readServePort() ?? (process.env['AKAPEN_HOME'] === undefined ? 4300 : null);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    fail(`AKAPEN_PORT: ${err.message}`);
  }
}

/**
 * Whether the management secret may go to the port `daemonPort` picked.
 *
 * Only to a port somebody chose for this home (`-p`, `AKAPEN_PORT`) or one its running
 * server recorded, while that server's process is alive. Not to the bare default: another
 * user on this machine can listen on 4300 before akapen does, and would be handed the one
 * secret that lets a request register any file.
 */
function secretMayGo(): boolean {
  if ((portFlagNamesServer ? args?.port : undefined) ?? (process.env['AKAPEN_PORT'] || undefined))
    return true;
  return recordedServerAlive();
}

/** Set by `daemon` when it held the management secret back from the port it was asking. */
let secretWithheld = false;

/** Why a refusal happened, when this command held the management secret back itself. */
const refusalCause = (): string =>
  secretWithheld
    ? `the management secret was not sent to port ${daemonPort()}, which no running server of this home recorded; set AKAPEN_PORT to that server's port`
    : "the token, or the management secret in akapen's home or AKAPEN_MANAGE_TOKEN";

/** The token a command presents to the server: `--token`, else as `currentToken` finds it. */
function clientToken(): string | null {
  return args?.token !== undefined && args.token !== '' ? args.token : currentToken();
}

/** Whether `-p` names akapen serve's port. Not for `akapen <file.md>`, where it is that server's own. */
let portFlagNamesServer = true;

/** A row of the server's `GET /api/documents`. */
type DaemonDocument = {
  id: string;
  file: string;
  session: string | null;
  url: string;
  title: string | null;
  round: number;
  unresolved: number;
  missing: boolean;
  added_at: string;
};

/**
 * A request to `akapen serve` on this machine, or null when nothing answers there.
 *
 * shortcut: always 127.0.0.1, so a server bound to one LAN address only is not found;
 * a registry entry for the server would find it, if that bind ever matters.
 */
async function daemon(
  path: string,
  init: RequestInit = {},
  token: string | null = clientToken(),
): Promise<Response | null> {
  const port = daemonPort();
  if (port === null) return null;
  const manageToken = readManageToken();
  const session = process.env['CLAUDE_CODE_SESSION_ID'] ?? '';
  // Only to the management API: a document's own routes have no use for it.
  const management = path.startsWith('/api/') && manageToken !== null;
  const sendSecret = management && secretMayGo();
  if (management && !sendSecret) secretWithheld = true;
  const headers: Record<string, string> = {
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...(session === '' ? {} : { 'x-akapen-session': session }),
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(sendSecret ? { 'x-akapen-manage': manageToken } : {}),
  };
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers,
      // A read only finds the server, and whatever holds the port should not hold the command.
      signal: AbortSignal.timeout(init.method === undefined ? 3_000 : 10_000),
    });
  } catch {
    return null;
  }
}

/**
 * Set by `daemonDocuments` when akapen serve answered but refused this command (its token
 * or management secret): running all the same. Kept apart from "not running", which the
 * same null would otherwise mean.
 */
let serveRefused = false;

/**
 * What `akapen serve` has registered, or null when it is not running — or when whatever
 * answers on its port is not it, which is told by the shape of the answer.
 */
async function daemonDocuments(token: string | null = clientToken()): Promise<DaemonDocument[] | null> {
  const res = await daemon('/api/documents', {}, token);
  // akapen's own refusals: the token (401), or the management secret / this machine (403).
  const refusal = res?.status === 401 || res?.status === 403 ? await res.text().catch(() => '') : '';
  if (
    (res?.status === 401 && refusal.startsWith('unauthenticated. open the URL akapen printed')) ||
    (res?.status === 403 &&
      (refusal.startsWith('the management secret') || refusal.startsWith('documents are managed')))
  ) {
    serveRefused = true;
    return null;
  }
  if (res === null || !res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) return null;
  return body.filter(
    (d): d is DaemonDocument =>
      typeof d === 'object' &&
      d !== null &&
      typeof (d as DaemonDocument).id === 'string' &&
      typeof (d as DaemonDocument).file === 'string',
  );
}

/** The API path of a registered document. Ids are file names, which may hold `#` or a space. */
const docPath = (id: string): string => `/d/${encodeURIComponent(id)}`;

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
 * The channel, which is not a command a person types.
 *
 * Claude Code spawns it over stdio from an MCP config entry, with no arguments: what it
 * watches is decided by the session id it inherits, so there is nothing to get wrong on
 * the command line. `channel instructions` is a running channel asking the akapen on disk
 * what it would say now.
 */
if (positional[0] === 'channel') {
  const { INSTRUCTIONS, runChannel } = await import('./channel.ts');
  if (positional[1] === 'instructions') {
    console.log(INSTRUCTIONS);
    process.exit(0);
  }
  await runChannel();
  // Only reached if the loop inside ever returns. Falling through would take `channel`
  // for the path of a document to serve.
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
  // Read before the probes as well as by them, so an id is known whichever read saw it.
  const entries = liveEntries();
  // `currentToken`, not `resolveToken`: listing is a read, and a read that generates and
  // stores a secret as a side effect is a surprise. An instance running on a token this
  // caller does not have simply does not answer, and is reported as not answering.
  // The documents `akapen serve` holds, listed beside the one-document servers (#305).
  const answered = await daemonDocuments();
  const documents = answered ?? [];
  const all = await liveInstances({ token: currentToken() });
  /**
   * Only what one session started.
   *
   * The filter is on the registry rather than on `sessions/`, because the registry is
   * where liveness is decided and `sessions/` is a reverse index for a reader that
   * cannot afford to ask. Two answers to "is it running" is one too many.
   */
  // Undefined: no filter. Null: a value no session in the registry matches.
  let session: string | null | undefined;
  try {
    session =
      args.session === undefined
        ? undefined
        : resolveSession(args.session, [
            ...entries.map((e) => e.sessionId),
            ...all.flatMap((e) => (e.record.origin?.id === undefined ? [] : [e.record.origin.id])),
            ...documents.flatMap((d) => (d.session === null ? [] : [d.session])),
          ]);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    fail(err.message);
  }
  const live = session === undefined ? all : all.filter((e) => e.record.origin?.id === session);
  const served = session === undefined ? documents : documents.filter((d) => d.session === session);
  // Reading the registry is the other half of the sweep's rule, and `list` has just
  // done it. Not `all`: an instance that did not answer may simply be busy, and the
  // registry keeps it for that reason — deleting its url here would contradict that.
  // Read again rather than reusing `entries`: an instance that registered during the
  // probes would otherwise have its url swept away while it runs.
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
        [
          ...live.map(({ record, status }) => ({
            pid: record.pid,
            host: record.host,
            port: record.port,
            url: urlOf(record),
            // The whole record, so `jq '.[] | select(.origin.id == "…")'` needs nothing
            // this command did not already know. Null for an entry written before origins
            // existed, or by a shell with no session to name.
            origin: record.origin ?? null,
            file: record.file,
            title: status.title,
            round: status.round,
            unresolved: status.unresolved,
            started_at: record.startedAt,
          })),
          // The same shape, so a reader of this list needs nothing new. No pid: the server is
          // one process for all of them, and a document is not a process.
          ...served.map((d) => ({
            pid: null,
            host: '127.0.0.1',
            port: daemonPort() ?? 0,
            url: d.url,
            origin: d.session === null ? null : { kind: 'claude-code', id: d.session },
            file: d.file,
            id: d.id,
            title: d.title,
            round: d.round,
            unresolved: d.unresolved,
            missing: d.missing,
            started_at: d.added_at,
          })),
        ],
        null,
        2,
      ),
    );
    process.exit(0);
  }
  if (live.length === 0 && served.length === 0) {
    // Each sentence says only what was observed (#157). A value nothing matches may be a
    // typo or a session that has closed everything, so it is not called a session. A
    // match with nothing live is a registered instance that did not answer — busy, or on
    // another token — so it is not called "none running" either.
    // An entry whose process is alive but did not answer is not "nothing running" (#221).
    // Why it did not answer is not known here, so no cause is named.
    const registered = args.session === undefined ? readInstances().length : 0;
    console.log(
      serveRefused && registered === 0
        ? `akapen serve is running on port ${daemonPort()} but refused this command (${refusalCause()})`
        : args.session === undefined && answered !== null && registered === 0
          ? `akapen serve is running on port ${daemonPort()}; nothing is registered`
          : args.session === undefined
            ? registered === 0
              ? 'no akapen is running'
              : `no akapen answered (${registered} registered)`
            : session === null
              ? `no akapen running here was started by a session matching ${JSON.stringify(args.session)}`
              : "that session's akapen did not answer",
    );
    process.exit(0);
  }
  const rows = [
    ...live.map(({ record, status }) => ({
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
    })),
    ...served.map((d) => ({
      pid: 'serve',
      session: d.session?.slice(0, 8) ?? '-',
      url: d.url,
      round: `R${String(d.round).padStart(3, '0')}`,
      unresolved: String(d.unresolved),
      file: d.missing ? `${d.file} (missing)` : d.file,
    })),
  ];
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

/**
 * The akapen serving `file`: a `post` to it, and the session to file as. The file is identified as
 * the store identifies it (the resolved path). `--token` as the server takes it, so an
 * instance started with one can be reached. With nothing answering, nothing is written
 * and this exits 1.
 */
async function reachInstance(file: string): Promise<{
  post: (path: string, done: string, check: string, body?: unknown) => Promise<unknown>;
  session: string;
}> {
  const token = args.token !== undefined && args.token !== '' ? args.token : currentToken();
  const target = resolve(file);
  // A document `akapen serve` holds is reached under its path there (#305).
  const registered = (await daemonDocuments(token))?.find((d) => d.file === target);
  const serving = registered ? null : (await liveInstances({ token })).find((e) => e.record.file === target);
  if (!registered && !serving) {
    // Said as observed: one may be running on another token, and not have answered. Not
    // written to the store instead (#258): a server that is running or starting holds the
    // round in memory and writes it back, and two of these at once would race each other.
    console.error(
      `akapen: no akapen serving ${target} answered, so nothing was written; ` +
        `start one (akapen ${JSON.stringify(file)}) and run this again`,
    );
    process.exit(1);
  }
  const base = registered
    ? `http://127.0.0.1:${daemonPort()}${docPath(registered.id)}`
    : `http://${reachableHost(serving!.record.host)}:${serving!.record.port}`;
  const session = process.env['CLAUDE_CODE_SESSION_ID'] ?? '';
  const headers: Record<string, string> = {
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...(session === '' ? {} : { 'x-akapen-session': session }),
  };
  const post = async (path: string, done: string, check: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      // It may have landed before the answer was lost, so a retry could post it twice.
      console.error(
        `akapen: ${done}${path} did not answer (${err instanceof Error ? err.name : String(err)}); ` +
          `check ${check} before sending it again`,
      );
      process.exit(1);
    });
    if (!res.ok) {
      console.error(`akapen: ${done}${path} answered ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    return res.json();
  };
  return { post, session };
}

/**
 * Close the current round and open the next from the command line (#178), rather than
 * with curl. Through the akapen serving the file, as reply and resolve are: the server
 * holds the round in memory.
 */
if (positional[0] === 'rounds') {
  const [, verb, file, ...extra] = positional;
  if (verb !== 'cut')
    fail(
      `rounds: unknown subcommand ${verb === undefined ? '(missing)' : JSON.stringify(verb)}; try \`akapen rounds cut <file.md>\``,
    );
  if (!file || !existsSync(file)) fail(`no such file: ${file ?? '(missing)'}`);
  if (extra.length > 0) fail(`rounds cut: unexpected ${JSON.stringify(extra.join(' '))}`);
  const { post } = await reachInstance(file);
  // The round's comments cannot show whether the cut landed; `akapen list` shows the round.
  const answer = (await post('/api/rounds', '', '`akapen list`')) as { round?: { n?: number } };
  const n = answer.round?.n;
  // A refused or unanswered cut already exited 1 in `post`; this guards an answer of an
  // unexpected shape, so a line saying it worked is never printed without a round.
  if (typeof n !== 'number') {
    console.error('akapen: /api/rounds answered without a round number; check `akapen list`');
    process.exit(1);
  }
  console.log(`round ${n} is now current`);
  process.exit(0);
}

/**
 * Reply to and resolve a comment from the command line (#130), rather than with curl.
 *
 * Through the akapen serving the file: the server keeps the current round's comments in
 * memory and writes them back, so a reply written to the store from here would be lost on
 * its next write. The file is identified as the store identifies it (the resolved path),
 * for both the comment lookup and the instance. A reply carries `X-Akapen-Session` when
 * there is a session to name, so it is filed as the agent's. Resolving toggles on the
 * server, so a comment already resolved is not sent, and the answer is checked.
 */
if (positional[0] === 'reply' || positional[0] === 'resolve') {
  const verb = positional[0];
  const [, file, id, text, ...extra] = positional;
  if (!file || !existsSync(file)) fail(`no such file: ${file ?? '(missing)'}`);
  if (!id) fail(`${verb}: which comment? Give its id, as \`akapen comments\` prints it`);
  if (verb === 'reply' && !text?.trim()) fail('reply: the text of the reply is missing');
  // A text in several words is one argument; quote it. Dropping the rest would send a part.
  if (extra.length > 0 || (verb === 'resolve' && text !== undefined)) {
    fail(
      `${verb}: unexpected ${JSON.stringify(
        [text, ...extra]
          .filter((x) => x !== undefined)
          .slice(verb === 'reply' ? 1 : 0)
          .join(' '),
      )}`,
    );
  }

  const comment = pendingComments(file, true).find((c) => c.id === id);
  if (!comment) {
    console.error(`akapen: no comment ${id} on ${resolve(file)}`);
    process.exit(1);
  }
  const alreadyResolved = comment.resolved && (verb === 'resolve' || args.resolve);
  if (verb === 'resolve' && alreadyResolved) {
    console.error(`akapen: ${id} is already resolved; resolving it again would reopen it`);
    process.exit(1);
  }
  // A reply to a resolved comment still goes; only the resolve is left out.
  const resolving = (verb === 'resolve' || args.resolve) && !alreadyResolved;

  const { post, session } = await reachInstance(file);
  if (verb === 'reply') {
    await post(`/api/comments/${encodeURIComponent(id)}/replies`, '', '`akapen comments`', {
      body: text,
    });
    console.log(`replied (filed as ${session === '' ? 'a person, no CLAUDE_CODE_SESSION_ID' : 'the agent'})`);
  }
  if (resolving) {
    const answer = (await post(
      `/api/comments/${encodeURIComponent(id)}/resolve`,
      verb === 'reply' ? 'replied, but ' : '',
      '`akapen comments`',
    )) as {
      comment?: { resolved?: boolean };
    };
    // A toggle: someone else may have resolved it since the store was read, and this reopened it.
    if (answer.comment?.resolved !== true) {
      console.error(`akapen: ${id} is open after the call; it was resolved meanwhile, and this reopened it`);
      process.exit(1);
    }
    console.log('resolved');
  } else if (alreadyResolved) console.log(`${id} was already resolved; left as it is`);
  process.exit(0);
}

/**
 * Register a document with `akapen serve` and print its URL (#305). The same path always
 * gets the same URL, so running this again — after the session was resumed, say — is
 * how it comes back. Nothing is started: the server is run by whatever runs services here.
 */
if (positional[0] === 'add') {
  const [, target, ...extra] = positional;
  if (!target || !existsSync(target)) fail(`no such file: ${target ?? '(missing)'}`);
  if (extra.length > 0) fail(`add: unexpected ${JSON.stringify(extra.join(' '))}`);
  // Read, not created: a running server already has the token it checks.
  const token = clientToken();
  const res = await daemon(
    '/api/documents',
    {
      method: 'POST',
      body: JSON.stringify({
        file: resolve(target),
        ...(args.root === undefined ? {} : { root: resolve(args.root) }),
      }),
    },
    token,
  );
  if (res === null) {
    console.error(
      `akapen: akapen serve is not answering on 127.0.0.1:${daemonPort() ?? '(no port: set AKAPEN_PORT for this AKAPEN_HOME)'}; start it (akapen serve) and run this again`,
    );
    process.exit(1);
  }
  if (!res.ok) {
    const why = await res.text();
    console.error(
      `akapen: akapen serve answered ${res.status}: ${why}${res.status === 403 && secretWithheld ? ` (${refusalCause()})` : ''}`,
    );
    process.exit(1);
  }
  const added = (await res.json()) as DaemonDocument;
  console.log(`akapen  ${added.file}`);
  console.log(`  url     ${token === null ? added.url : `${added.url}?token=${encodeURIComponent(token)}`}`);
  console.log(`  id      ${added.id}`);
  process.exit(0);
}

/** Unregister everything a session registered: its SessionEnd hook runs this. The comments stay. */
if (positional[0] === 'remove' && args.session !== undefined) {
  if (positional.length > 1)
    fail('remove --session takes no path: it removes everything that session registered');
  const res = await daemon(`/api/documents?session=${encodeURIComponent(args.session)}`, {
    method: 'DELETE',
  });
  if (res === null || !res.ok) {
    console.error(
      `akapen: removing the documents of ${args.session} failed: ${res === null ? `akapen serve is not answering on 127.0.0.1:${daemonPort()}` : `${res.status} ${await res.text()}`}`,
    );
    process.exit(1);
  }
  const { removed } = (await res.json()) as { removed: string[] };
  console.log(
    removed.length === 0 ? 'nothing was registered by that session' : `removed ${removed.join(', ')}`,
  );
  process.exit(0);
}

/**
 * Register again what a session registered last (#305). Its SessionStart hook runs this
 * when the session is resumed, so the URLs handed out before work again without anyone
 * asking: they follow from the paths, so they come back as they were.
 */
if (positional[0] === 'restore') {
  const [, session, ...extra] = positional;
  if (!session) fail('restore: whose documents? Give the session id');
  if (extra.length > 0) fail(`restore: unexpected ${JSON.stringify(extra.join(' '))}`);
  const res = await daemon(`/api/sessions/${encodeURIComponent(session)}/restore`, { method: 'POST' });
  if (res === null || !res.ok) {
    console.error(
      `akapen: restore failed: ${res === null ? `akapen serve is not answering on 127.0.0.1:${daemonPort()}` : `${res.status} ${await res.text()}`}`,
    );
    process.exit(1);
  }
  const { restored, refused } = (await res.json()) as {
    restored: DaemonDocument[];
    refused: { file: string; reason: string }[];
  };
  for (const d of restored) console.log(`${d.url}  ${d.file}`);
  for (const r of refused) console.error(`akapen: not restored: ${r.file}: ${r.reason}`);
  if (restored.length === 0 && refused.length === 0) console.log('nothing to restore for that session');
  // A file deleted since is only reported: a resume hook would otherwise fail for good on it.
  process.exit(refused.some((r) => !r.reason.startsWith('no such file')) ? 1 : 0);
}

/** Unregister a document by its path, or by its id or a unique prefix of it. Its comments stay. */
if (positional[0] === 'remove') {
  const [, target, ...extra] = positional;
  if (!target) fail('remove: which document? Give its path or its id, as akapen list prints it');
  if (extra.length > 0) fail(`remove: unexpected ${JSON.stringify(extra.join(' '))}`);
  const documents = await daemonDocuments();
  if (documents === null) {
    console.error(
      serveRefused
        ? `akapen: akapen serve on port ${daemonPort()} refused this command (${refusalCause()})`
        : `akapen: akapen serve is not answering on 127.0.0.1:${daemonPort() ?? '(no port)'}`,
    );
    process.exit(1);
  }
  const byPath = documents.find((d) => d.file === resolve(target));
  // An exact id wins over the longer ids it is a prefix of.
  const exact = documents.find((d) => d.id === target);
  const byId = documents.filter((d) => d.id.startsWith(target));
  const found = byPath ?? exact ?? (byId.length === 1 ? byId[0] : undefined);
  if (found === undefined) {
    console.error(
      byId.length > 1
        ? `akapen: ${JSON.stringify(target)} matches more than one document: ${byId.map((d) => d.id).join(', ')}`
        : `akapen: nothing registered as ${JSON.stringify(target)}`,
    );
    process.exit(1);
  }
  const res = await daemon(`/api/documents/${encodeURIComponent(found.id)}`, { method: 'DELETE' });
  if (res === null || !res.ok) {
    console.error(
      `akapen: removing ${found.id} failed: ${res === null ? 'no answer' : `${res.status} ${await res.text()}`}`,
    );
    process.exit(1);
  }
  console.log(`removed ${found.id} (${found.file}); its comments stay`);
  process.exit(0);
}

if (positional[0] === 'comments') {
  const file = positional[1];
  if (!file || !existsSync(file)) fail(`no such file: ${file ?? '(missing)'}`);
  // Unresolved comments from earlier rounds are included. Closing a round removes them
  // from the screen, not from the feedback. Line numbers refer to that round's snapshot
  // and will not match the live file, so an agent matches on `anchor` (the text as it was).
  // Through `akapen serve` when it holds the document (#305): the server owns the store.
  const registered = (await daemonDocuments())?.find((d) => d.file === resolve(file));
  let current: number;
  let comments: ReturnType<typeof pendingComments>;
  if (registered) {
    const res = await daemon(`${docPath(registered.id)}/api/pending${args.all ? '?all=1' : ''}`);
    if (res === null || !res.ok) {
      console.error(`akapen: akapen serve did not hand over the comments on ${registered.file}`);
      process.exit(1);
    }
    ({ current, comments } = (await res.json()) as { current: number; comments: typeof comments });
  } else {
    current = loadReview(file).currentRound;
    comments = pendingComments(file, args.all);
  }
  const review = { currentRound: current };
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
        // Who spoke last on the thread (#249), so a reader need not walk `replies`: until
        // someone resolves it, a comment the agent has answered is still listed here. A
        // comment carries no kind of its own, so one with no reply is treated as a person's.
        last_author_kind: c.replies?.at(-1)?.authorKind ?? 'human',
        // The agent's own replies are noise to it, but a person's reply to one is new
        // feedback — "could not fix, because X" answered with "then do Y instead". Y
        // only arrives if the thread comes with the comment.
        replies: (c.replies ?? []).map((r) => ({
          id: r.id,
          body: r.body,
          author: r.author,
          author_kind: r.authorKind,
          session_id: r.sessionId ?? null,
          created_at: r.createdAt,
        })),
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}

/**
 * The server for every registered document (#305). Its port is fixed: a URL handed out
 * has to work tomorrow, so a port that is taken is a failure, never a move.
 */
if (positional[0] === 'serve') {
  if (positional.length > 1) fail(`serve: unexpected ${JSON.stringify(positional.slice(1).join(' '))}`);
  // One server per home: a second would write documents.json from its own copy.
  // Asked only while the recorded server's process lives: otherwise the port may be anyone's,
  // and the probe carries the management secret.
  const runningOn = recordedServerAlive() ? readServePort() : null;
  if (runningOn !== null) {
    const token = clientToken();
    const manage = readManageToken();
    const answer = await fetch(`http://127.0.0.1:${runningOn}/api/documents`, {
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(manage === null ? {} : { 'x-akapen-manage': manage }),
      },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    // A listing, or akapen's own refusal (a server on another token). Whatever else took the
    // port after a crash is not a server here.
    const text = answer === null ? '' : await answer.text().catch(() => '');
    if (
      (answer?.ok === true && text.startsWith('[')) ||
      (answer?.status === 401 && text.startsWith('unauthenticated. open the URL akapen printed')) ||
      (answer?.status === 403 &&
        (text.startsWith('the management secret') || text.startsWith('documents are managed')))
    ) {
      fail(`akapen serve is already running for ${akapenHome()} on port ${runningOn}`);
    }
  }
  if (args.root !== undefined) fail('serve: --root belongs to akapen add, per document');
  let host: string;
  let port: number;
  try {
    host = resolveHost(args.host);
    // Not the recorded port: that is how clients find a running server, and one left behind
    // by a crash would move this server off the port its URLs were handed out on.
    port = resolvePort(args.port ?? (process.env['AKAPEN_PORT'] || undefined), 4300);
    // The CLI reaches the server on 127.0.0.1, and only loopback may manage it, so it has to
    // listen there: loopback itself, or every interface.
    // Not `::1` or `localhost`: the CLI connects to 127.0.0.1, which neither is sure to answer on.
    if (!['127.0.0.1', '0.0.0.0', '::'].includes(host)) {
      throw new UsageError(
        `serve: --host ${host} would leave the CLI on this machine unable to reach it; use 0.0.0.0 or 127.0.0.1`,
      );
    }
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    fail(err.message);
  }
  const advertisedServe = advertisedFor(host);
  secureHome();
  const serveToken = args['no-auth'] ? null : resolveToken(args.token);
  const { startDaemon } = await import('@akapen/server');
  let daemonServer: ReturnType<typeof startDaemon>;
  try {
    daemonServer = startDaemon({
      host,
      port,
      token: serveToken,
      tokenPinned: tokenIsPinned(args.token),
      author: args.author ?? process.env['USER'] ?? 'user',
      advertised: advertisedServe,
      manageToken: resolveManageToken(),
      ...(args.css ? { cssPath: resolve(args.css) } : {}),
      ...(args.keymap ? { keymapPath: resolve(args.keymap) } : {}),
    });
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'EADDRINUSE') throw err;
    fail(
      `port ${port} is in use. If it is akapen serve, it is already running; otherwise pick another with -p or $AKAPEN_PORT`,
    );
  }
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.once(signal, () => {
      void daemonServer.stop().finally(() => process.exit(code));
    });
  }
  console.log(`akapen serve`);
  console.log(
    `  url     ${serveToken === null ? daemonServer.url : `${daemonServer.url}/?token=${encodeURIComponent(serveToken)}`}`,
  );
  if (serveToken === null)
    console.log(`  note    --no-auth: anyone who can reach this address can read and write.`);
  // Kept alive by the socket.
  await new Promise(() => {});
}

const file = positional[0]!;
if (!existsSync(file)) fail(`no such file: ${file}`);
// The same store held by akapen serve as well would be overwritten by whichever wrote last.
portFlagNamesServer = false;
// Only the server of this home: one on another home keeps another store, so it cannot hold this
// file's comments, and a port nobody recorded here is not worth a request on every start.
const served = readServePort() === null ? null : await daemonDocuments();
// Refused, it may well hold this file: starting would put a second holder on its store.
if (serveRefused) {
  fail(
    `akapen serve is running on port ${daemonPort()} but refused this command (another token, or no management secret); give it those, or stop it first`,
  );
}
if (served?.some((d) => d.file === resolve(file))) {
  fail(
    `akapen serve already serves ${resolve(file)}; open it there (akapen list), or akapen remove it first`,
  );
}
// Checked here rather than left to 404: a mistyped root would otherwise show every
// image as broken with nothing saying why.
if (args.root !== undefined) {
  if (!statSync(args.root, { throwIfNoEntry: false })?.isDirectory())
    fail(`--root is not a directory: ${args.root}`);
  // Images resolve against the document, so a root that does not hold it can serve none
  // of them; say so rather than start with every image a 404.
  if (!isInside(realpathSync(args.root), realpathSync(file))) {
    fail(`--root does not contain the document: ${args.root}`);
  }
}

// Every value below is a string or absent — parseArgs rejects the boolean case — so
// there is nothing left here to cast.
let host: string;
let port: number;
try {
  host = resolveHost(args.host);
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
const advertised = advertisedFor(host);

function advertisedFor(bind: string): string | null {
  const requested = args.advertise ?? process.env['AKAPEN_ADVERTISE'] ?? '';
  if (requested === '') return null;
  try {
    return resolveAdvertised(requested, bind);
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

// Loaded here rather than at the top: every subcommand runs this file, and the server
// (hono, the renderer, the browser assets) is the bulk of its memory. `channel` stays
// resident for a whole Claude Code session and never serves a page, so paying for the
// server there costs about 20MB per session for nothing.
const { startServer } = await import('@akapen/server');
let started: ReturnType<typeof startServer>;
try {
  started = startServer({
    file,
    host,
    port,
    // Only the default moves. `-p` named a port, and being moved off it silently would
    // be worse than failing (#107).
    fallBackIfTaken: args.port === undefined,
    token,
    tokenPinned: tokenIsPinned(args.token),
    author: args.author ?? process.env['USER'] ?? 'user',
    advertised,
    // exactOptionalPropertyTypes: `?:` means "may be absent", not "may be undefined".
    // With no value given, drop the key entirely.
    ...(args.css ? { cssPath: resolve(args.css) } : {}),
    ...(args.keymap ? { keymapPath: resolve(args.keymap) } : {}),
    ...(args.root ? { root: resolve(args.root) } : {}),
  });
} catch (err) {
  if ((err as { code?: unknown }).code !== 'EADDRINUSE') throw err;
  // Only an explicit port reaches here; the default falls back instead.
  fail(`--port ${port} is in use. Pick another, or -p 0 to let the OS choose`);
}
const { server, stop, storeDir, round, movedFrom } = started;

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
 * on a unix socket, which nothing here does, so the requested port stands in for it.
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
if (movedFrom !== null) console.log(`  note    port ${movedFrom} was taken, so the OS picked ${server.port}`);
console.log(`  round   ${String(round).padStart(3, '0')}`);
console.log(`  store   ${storeDir}`);
if (token === null) {
  console.log(`  note    --no-auth: anyone who can reach this address can read and write.`);
}
