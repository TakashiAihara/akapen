#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { AdvertiseError, resolveAdvertised } from '@akapen/core/addresses';

import {
  HomeHeldError,
  readServePort,
  recordedServerAlive,
  servePath,
  whatAnswers,
} from '@akapen/core/documents';
import { akapenHome, type pendingComments } from '@akapen/core/store';
import {
  currentToken,
  ManageTokenError,
  readManageToken,
  resolveManageToken,
  resolveToken,
  rotateToken,
  secureHome,
  tokenIsPinned,
} from '@akapen/core/token';
import { parseArgs, resolveHost, resolvePort, resolveSession, UsageError, type Args } from './args.ts';

/**
 * Every request this process makes goes to akapen serve on 127.0.0.1 and carries the token,
 * most of them the management secret too. Bun's fetch sends a loopback request through
 * `HTTP_PROXY` like any other (measured on 1.4.0, #321), which would hand both to the proxy.
 * It has no per-request switch (`proxy: ''` is ignored) and does not notice the variable
 * being deleted, but it reads the exception list at each request. The lowercase spelling
 * wins over `NO_PROXY` when both are there, so that is the one set. Replaced rather than
 * added to: nothing here fetches anywhere else. Before anything is fetched, the channel included.
 */
process.env['no_proxy'] = '127.0.0.1';

const USAGE = `akapen — markdown inline review

  akapen serve [options]         start the server that serves every registered document
  akapen add <file.md>           register a document with that server and print its URL
                                 (--root <dir> to serve its images from a wider directory)
  akapen remove <file.md|id>     unregister a document (its comments stay;
                                 --session <id> instead: every document that session
                                 registered, for its SessionEnd hook)
  akapen restore <session-id>    register again what that session registered last,
                                 for its SessionStart hook on resume
  akapen comments <file.md>      print unresolved comments as JSON (for agents)
  akapen reply <file.md> <id> <text>   reply to a comment (--resolve to close it too;
                                       -- before a text that starts with a dash)
  akapen resolve <file.md> <id>  resolve a comment
  akapen rounds cut <file.md>    close the current round and open the next one
                                 (none when the file matches the current round)
  akapen list                    print what akapen serve has registered
  akapen channel                 push this session's comments to Claude Code (MCP channel)
  akapen token                   print this host's token (--rotate to replace it)

options:
  --host <addr>            serve: listen address: 127.0.0.1 (default), 0.0.0.0 or ::
  -p, --port <n>           serve: the port (default $AKAPEN_PORT or 4300, never moved off;
                           0: let the OS pick). The other commands reach the server on
                           127.0.0.1 at -p, $AKAPEN_PORT, the port the running server
                           recorded, or 4300
  -A, --advertise <addr>   serve: address to print in the URL, or an interface to take one
                           from ($AKAPEN_ADVERTISE sets it once per host)
  --css <file>             serve: extra stylesheet to load
  --keymap <file>          serve: JSON overriding the keymap ({ "action": ["key"] })
  --root <dir>             add: file root: serve images the document refers to from anywhere
                           under this directory (default: the document's own directory)
  --author <name>          serve: comment author (default $USER)
  --token <s>              use this token instead of the stored one
  --no-auth                serve: no token at all (only behind something that authenticates)
  --all                    comments: include resolved ones
  --json                   list: print as JSON (for agents)
  --session <id>           list: only what that session registered (a unique prefix works)
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
    const named = args?.port ?? (process.env['AKAPEN_PORT'] || undefined);
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
  if (args?.port ?? (process.env['AKAPEN_PORT'] || undefined)) return true;
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
 * Set by `daemon` when something that is not akapen serve answered on the port. It asks
 * before each request, with no credential (#320): the token and the management secret go
 * to akapen serve, not to whatever holds its port.
 */
let somethingElse = false;

/** Why no answer came from akapen serve, for a message: nothing listens there, or something else does. */
const noAnswer = (): string => {
  const at = `127.0.0.1:${daemonPort() ?? '(no port: set AKAPEN_PORT for this AKAPEN_HOME)'}`;
  return somethingElse
    ? `what answers on ${at} is not akapen serve and was sent nothing (an akapen serve from before this version has to be restarted)`
    : `akapen serve is not answering on ${at}`;
};

/**
 * A request to `akapen serve` on this machine, or null when it is not what answers there.
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
  const answers = await whatAnswers(port);
  somethingElse = answers === 'other';
  if (answers !== 'serve') return null;
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
      // The management secret does not follow a redirect to wherever it points.
      redirect: 'manual',
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
 * answers on its port is not it, which `daemon` asks before it sends anything.
 */
async function daemonDocuments(token: string | null = clientToken()): Promise<DaemonDocument[] | null> {
  const res = await daemon('/api/documents', {}, token);
  // akapen serve's own refusals, `daemon` having asked that it is the one answering: the
  // token (401), or the management secret / this machine (403).
  if (res?.status === 401 || res?.status === 403) {
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
 * The token, for a script that has to present one.
 *
 * The reply and resolve endpoints are HTTP, and so is anything watching `/api/status`. Printing it
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
  const answered = await daemonDocuments();
  const documents = answered ?? [];
  // Undefined: no filter. Null: a value no session with a registration matches.
  let session: string | null | undefined;
  try {
    session =
      args.session === undefined
        ? undefined
        : resolveSession(
            args.session,
            documents.flatMap((d) => (d.session === null ? [] : [d.session])),
          );
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    fail(err.message);
  }
  const served =
    session === undefined
      ? documents
      : session === null
        ? []
        : documents.filter((d) => d.session === session);
  if (args.json) {
    // An empty list on stdout either way; a reader of it is told on stderr what it does not mean.
    if (somethingElse) console.error(`akapen: ${noAnswer()}`);
    console.log(
      JSON.stringify(
        served.map((d) => ({
          // No pid: the server is one process for all of them, and a document is not a process.
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
        null,
        2,
      ),
    );
    process.exit(0);
  }
  if (served.length === 0) {
    // Each sentence says only what was observed (#157). A value nothing matches may be a
    // typo or a session whose documents were all removed, so it is not called a session.
    console.log(
      serveRefused
        ? `akapen serve is running on port ${daemonPort()} but refused this command (${refusalCause()})`
        : answered === null
          ? somethingElse
            ? noAnswer()
            : 'no akapen is running'
          : session === undefined
            ? `akapen serve is running on port ${daemonPort()}; nothing is registered`
            : `no document registered with akapen serve belongs to a session matching ${JSON.stringify(args.session)}`,
    );
    process.exit(0);
  }
  const rows = served.map((d) => ({
    pid: 'serve',
    // Enough of the id to tell five apart, which is what the column is for. The whole of
    // it is in `--json`, for anything that has to match rather than read.
    session: d.session?.slice(0, 8) ?? '-',
    url: d.url,
    round: `R${String(d.round).padStart(3, '0')}`,
    unresolved: String(d.unresolved),
    file: d.missing ? `${d.file} (missing)` : d.file,
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

/** The comments of a registered document, as its server holds them: the current round, and the comments of every round. */
type Pending = { current: number; comments: ReturnType<typeof pendingComments> };

/**
 * Exit 1, saying why `file` cannot be reached through `akapen serve`: it is not running, it
 * refused this command, or the file is not registered with it. `consequence` is what that
 * means for the command ("nothing was written").
 */
function unreachable(file: string, documents: DaemonDocument[] | null, consequence: string): never {
  // The disk is looked at only here, once the server has answered that the file is not
  // registered: a registered document whose file is gone still takes replies (#345).
  if (documents !== null && !existsSync(file)) fail(`no such file: ${file}`);
  console.error(
    documents === null
      ? serveRefused
        ? `akapen: akapen serve on port ${daemonPort()} refused this command (${refusalCause()}), so ${consequence}`
        : `akapen: ${noAnswer()}, so ${consequence}`
      : `akapen: ${resolve(file)} is not registered with akapen serve, so ${consequence}; run \`akapen add ${file}\` first`,
  );
  process.exit(1);
}

/** What `akapen serve` holds of a registered document. The store is the server's: nothing here reads it off disk. */
async function pendingOf(doc: DaemonDocument, all: boolean): Promise<Pending> {
  const res = await daemon(`${docPath(doc.id)}/api/pending${all ? '?all=1' : ''}`);
  if (res === null || !res.ok) {
    // Registered, but with neither a file nor a round there is nothing the server can open.
    if (res?.status === 404 && !existsSync(doc.file)) fail(`no such file: ${doc.file}`);
    console.error(`akapen: akapen serve did not hand over the comments on ${doc.file}`);
    process.exit(1);
  }
  return (await res.json()) as Pending;
}

/**
 * The document `akapen serve` holds for `file`: a `post` to it, and the session to file as.
 * The file is identified as the server identifies it (the resolved path). `--token` as the
 * server takes it, so one started with it can be reached. With nothing answering, or the
 * file not registered, nothing is written and this exits 1: the server holds the round in
 * memory and writes it back, so a write from here would be lost on its next one.
 */
async function reachInstance(file: string): Promise<{
  post: (path: string, done: string, check: string, body?: unknown) => Promise<unknown>;
  registered: DaemonDocument;
  session: string;
}> {
  const token = args.token !== undefined && args.token !== '' ? args.token : currentToken();
  const documents = await daemonDocuments(token);
  const registered = documents?.find((d) => d.file === resolve(file));
  if (!registered) unreachable(file, documents, 'nothing was written');
  const base = `http://127.0.0.1:${daemonPort()}${docPath(registered.id)}`;
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
    return res.json().catch(() => {
      console.error(
        `akapen: ${done}${path} answered ${res.status} with a body that is not JSON; check ${check}`,
      );
      process.exit(1);
    });
  };
  return { post, registered, session };
}

/**
 * Close the current round and open the next from the command line (#178), rather than
 * with curl. Through `akapen serve`, as reply and resolve are: it holds the round in memory.
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
 * Through `akapen serve`: it keeps the current round's comments in memory and writes them
 * back, so a reply written to the store from here would be lost on its next write. The
 * comment is looked up through it as well. A reply carries `X-Akapen-Session` when
 * there is a session to name, so it is filed as the agent's. Resolving toggles on the
 * server, so a comment already resolved is not sent, and the answer is checked: one that
 * comes back open was resolved by someone else meanwhile, and is toggled back once.
 */
if (positional[0] === 'reply' || positional[0] === 'resolve') {
  const verb = positional[0];
  const [, file, id, text, ...extra] = positional;
  if (!file) fail('no such file: (missing)');
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

  const { post, registered, session } = await reachInstance(file);
  const comment = (await pendingOf(registered, true)).comments.find((c) => c.id === id);
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

  if (verb === 'reply') {
    await post(`/api/comments/${encodeURIComponent(id)}/replies`, '', '`akapen comments`', {
      body: text,
    });
    console.log(`replied (filed as ${session === '' ? 'a person, no CLAUDE_CODE_SESSION_ID' : 'the agent'})`);
  }
  if (resolving) {
    const toggle = async (done: string) =>
      (
        (await post(`/api/comments/${encodeURIComponent(id)}/resolve`, done, '`akapen comments`')) as {
          comment?: { resolved?: boolean };
        } | null
      )?.comment?.resolved;
    let state = await toggle(verb === 'reply' ? 'replied, but ' : '');
    // A toggle: someone else resolved it since the store was read, so this reopened it.
    // Toggled back once. A third resolve landing in between is undone by it, and shows as open.
    const raced = state === false;
    // Said if the toggle back fails: this call reopened it, and whether the second landed is unknown.
    if (raced)
      state = await toggle(`reopened ${id}, which someone had resolved meanwhile, and the toggle back `);
    if (state === false) {
      console.error(
        `akapen: reopened ${id}, which someone had resolved meanwhile, and the toggle back left it open; check \`akapen comments\``,
      );
      process.exit(1);
    }
    // Not toggled again on an answer of another shape: a second call could just as well reopen it.
    if (state !== true) {
      const what = raced
        ? `reopened ${id}, which someone had resolved meanwhile, and the toggle back`
        : `the resolve of ${id}`;
      console.error(
        `akapen: ${what} answered without its state; check \`akapen comments\` before resolving again`,
      );
      process.exit(1);
    }
    console.log(raced ? 'resolved (someone resolved it meanwhile, and this toggled it back)' : 'resolved');
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
  // What used to follow `akapen <file.md>` would otherwise be dropped without a word.
  const serveOnly = (['host', 'advertise', 'css', 'keymap', 'author', 'no-auth'] as const).filter(
    (k) => args[k] !== undefined && args[k] !== false,
  );
  if (serveOnly.length > 0)
    fail(`add: --${serveOnly.join(', --')} belong to akapen serve, which serves every document`);
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
    console.error(`akapen: ${noAnswer()}; start it (akapen serve) and run this again`);
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
      `akapen: removing the documents of ${args.session} failed: ${res === null ? noAnswer() : `${res.status} ${await res.text()}`}`,
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
      `akapen: restore failed: ${res === null ? noAnswer() : `${res.status} ${await res.text()}`}`,
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
        : `akapen: ${noAnswer()}`,
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
  if (!file) fail('no such file: (missing)');
  // Unresolved comments from earlier rounds are included. Closing a round removes them
  // from the screen, not from the feedback. Line numbers refer to that round's snapshot
  // and will not match the live file, so an agent matches on `anchor` (the text as it was).
  // Through `akapen serve`: it owns the store (#305).
  const documents = await daemonDocuments();
  const registered = documents?.find((d) => d.file === resolve(file));
  if (!registered) unreachable(file, documents, 'there is nothing to read');
  const { current, comments } = await pendingOf(registered, args.all);
  console.log(
    JSON.stringify(
      comments.map((c) => ({
        id: c.id,
        path: resolve(file),
        round: c.round,
        // Whether it belongs to the current round. Older ones are feedback on the document
        // as it was, so treat their line numbers as already shifted in the live file.
        current_round: c.round === current,
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
 * `--advertise` / `-A`, or `AKAPEN_ADVERTISE` for a host that always wants the same one.
 *
 * Resolved before the socket is bound, so a value this server would refuse costs a
 * message rather than a server that is running and cannot be opened.
 *
 * The flag beats the environment. The variable is set once per host, so reaching for the
 * flag is what says this invocation is the exception — the other way round would mean
 * the exception could only be expressed by unsetting something.
 *
 * An empty variable is an unset one. `AKAPEN_ADVERTISE=` in a profile that builds it
 * conditionally is far more likely than somebody asking to advertise nothing, and the
 * flag form of the same mistake is already refused by parseArgs.
 */
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
 * The server for every registered document (#305). Its port is fixed: a URL handed out
 * has to work tomorrow, so a port that is taken is a failure, never a move.
 */
if (positional[0] === 'serve') {
  if (positional.length > 1) fail(`serve: unexpected ${JSON.stringify(positional.slice(1).join(' '))}`);
  // One server per home: a second would write documents.json from its own copy.
  // The recorded port is asked, with no credential, whatever became of the recorded pid:
  // a server in a container has a pid that means nothing out here, and it still answers.
  const runningOn = readServePort();
  const running = runningOn === null ? 'nothing' : await whatAnswers(runningOn);
  if (running === 'serve')
    fail(
      `akapen serve is already running for ${akapenHome()} on port ${runningOn}. ` +
        `If that is the server of another home, remove ${servePath()}`,
    );
  // The recorded process lives and its port answers, without the marker: an akapen serve
  // from before the marker, most likely. Starting beside it would be the second writer.
  // With the process gone, the port is anyone's now and is no server here.
  if (running === 'other' && recordedServerAlive())
    fail(
      `the server ${akapenHome()} recorded is running (port ${runningOn}) but does not answer as this version's akapen serve. ` +
        `Stop it first if it is an akapen serve from before; if it is something else, remove ${servePath()}`,
    );
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
    if (err instanceof ManageTokenError) {
      console.error(`akapen: ${err.message}`);
      process.exit(1);
    }
    if (err instanceof HomeHeldError) {
      const { pid, port: theirs } = err.holder;
      fail(
        `akapen serve is already running for ${akapenHome()} (pid ${pid}${theirs === null ? ', starting' : `, port ${theirs}`}). ` +
          `If pid ${pid} is not akapen serve, remove ${servePath()}`,
      );
    }
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

/**
 * What `akapen <file.md>` was: one process, and one port, for one document. It is gone, and
 * anything else that is not a command ends here too.
 */
console.error(
  `akapen: ${JSON.stringify(positional[0])} is not a command. akapen <file.md> no longer starts a server of its own: ` +
    `start \`akapen serve\` (once, wherever services on this machine are started), then run \`akapen add <file.md>\`.`,
);
process.exit(2);
