import { readFileSync, realpathSync, rmSync, statSync, watch, existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import * as v from 'valibot';
import { vValidator } from '@hono/valibot-validator';
import { ASSETS, mimeFor } from './assets.ts';
import { buildDoc } from '@akapen/core/blocks';
import {
  documentId,
  readDocuments,
  forgetRegistration,
  registrationsOf,
  servePath,
  writeDocuments,
  writeRegistration,
  writeServePort,
  type DocumentEntry,
} from '@akapen/core/documents';
import { FILE_ROUTE, imageMime, isInside, resolveDocumentFile } from '@akapen/core/files';
import { allowedHostnames, hostnameOf } from '@akapen/core/hosts';
import { readToken, tokensMatch } from '@akapen/core/token';
import {
  addReply,
  carriedOver,
  ensureRound,
  loadComments,
  loadReview,
  makeComment,
  openRound,
  pendingComments,
  roundContent,
  renameLegacyStore,
  saveComments,
  storeDir,
  updateComment,
  type Comment,
  type Review,
} from '@akapen/core/store';
import {
  detectOrigin,
  liveInstances,
  readInstances,
  registerInstance,
  removeInstance,
} from '@akapen/core/instances';
import { forgetUrl, liveEntries, recordUrl, sweep as sweepSessions } from '@akapen/core/sessions';
import { urlsFor } from '@akapen/core/addresses';
import {
  CreateCommentSchema,
  CreateReplySchema,
  DocQuerySchema,
  type ChangedEvent,
  type ChangedState,
  type DocPayload,
  type InstancesPayload,
  type RoundEvent,
  type RoundState,
  type StatusPayload,
} from '@akapen/shared';
import { documentTitle } from '@akapen/shared/title';

export type ServeOptions = {
  file: string;
  host: string;
  port: number;
  /**
   * Listen on a port the OS picks when `port` is taken, instead of failing (#107). For
   * the default port only: a port asked for by name that is moved off silently is worse
   * than one that fails. The result's `movedFrom` says it happened.
   */
  fallBackIfTaken?: boolean;
  author: string;
  /**
   * The address `--advertise` pinned, when one was pinned.
   *
   * Only used to decide what to record as this instance's url. The startup line derives
   * the same answer from the same value, and a registry that disagreed with the line
   * printed a moment earlier would be worse than no registry.
   */
  advertised?: string | null;
  cssPath?: string;
  keymapPath?: string;
  /**
   * The directory images beside the document may be served from (#81). Absent means
   * the document's own directory, the narrowest root that makes ordinary documents work.
   */
  root?: string;
  /**
   * The shared secret every request must present, or null for `--no-auth`.
   *
   * Null exists for the case where something in front already authenticates — Tailscale
   * Serve, or a proxy — and is not the default at any bind address. Loopback is not the
   * exception it looks like: a page in the reader's own browser can reach `127.0.0.1`,
   * which is what `allowedHostnames` below is about.
   */
  token: string | null;
  /**
   * Whether that secret is fixed for the life of the process.
   *
   * True for one handed in with `--token` or `AKAPEN_TOKEN`, which belongs to whoever
   * handed it in. False for one read from the store, where `akapen token --rotate` has
   * to take effect on the servers that are already running — otherwise the only
   * revocation there is revokes nothing until every instance is restarted.
   */
  tokenPinned: boolean;
};

/** Addresses that only the host itself can reach. `::1` also arrives bracketed. */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** The cookie the browser is handed once, so nothing after the first visit carries a token. */
const COOKIE = 'akapen_token';

/** How many times, 200 ms apart, to look for a file renamed away before giving up on it. */
const REARM_TRIES = 25;

/** Under the 10-second idle timeout set on the server, so even a tick late by one interval lands in time. */
const HEARTBEAT_MS = 3_000;

/** Bun's default, said here because the heartbeat is sized against it. */
const IDLE_TIMEOUT_S = 10;

/** Methods that only read. A cross-origin one of these cannot be read back without CORS. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * What `x-akapen-session` may hold: a session id, not free text, since it is stored and
 * shown. An empty value is refused rather than filed as an agent with no session.
 *
 * NOTE: this does not catch an unset `$CLAUDE_CODE_SESSION_ID`. curl drops a header whose
 * value is empty, so the reply arrives with no header and is filed as a person's. The
 * channel's instructions write `${CLAUDE_CODE_SESSION_ID:?}` for that reason: the shell
 * refuses to run the command instead.
 */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * How long to wait between the two reads that decide the file has stopped moving.
 *
 * 50ms everywhere, and `AKAPEN_SETTLE_MS` for the one test that asserts a moving file is
 * refused. That test has to land a write inside every one of these gaps, from a timer in
 * another process, and at 50ms it has five writes of room — which a loaded CI runner
 * loses to a stall, reporting it as the guard not firing (#135). Handing that test a long
 * interval costs it a few seconds and buys a margin no plausible stall reaches.
 *
 * Deliberately not a CLI flag. Nobody reviewing a document is served by choosing this,
 * and the only caller that needs it is one that spawns the process. It is written down
 * with the other variables in the README rather than left for someone to find in here.
 *
 * A value that is not a positive whole number of milliseconds falls back to the shipped
 * one rather than refusing to start: a typo in an environment variable should not be
 * able to end a review that is running. The test that depends on the long interval
 * asserts the refusal took long enough to have used it, so a typo there fails loudly
 * instead of quietly restoring the flake.
 *
 * Not bounded above. A delay past 2^31-1 does not wait longer, it fires on the next tick,
 * so a value up there means no gap at all — but refusing it needs a test, and the only
 * test that could tell the two apart is a moving file refused at 50ms, which is the
 * margin this variable exists to get rid of. A guard nothing pins is worth less than the
 * sentence saying it is not there.
 */
const SETTLE_MS = ((): number => {
  const asked = Number(process.env['AKAPEN_SETTLE_MS']);
  return Number.isInteger(asked) && asked > 0 ? asked : 50;
})();

/** What a document's routes are handed by whoever forwarded the request to them. */
type DocEnv = { Bindings: { checkedSecret: string | null } };

type DocumentOptions = {
  author: string;
  /** See ServeOptions.root. */
  root?: string;
  /** Told when a comment or a reply has been stored, so a waiting channel can look now. */
  onWrite?: () => void;
};

/**
 * One document: its round, its comments, its watcher and its streams, and the routes
 * that read and write them, relative to wherever the document is mounted.
 *
 * Split out of the server so one process can hold many (#305). The routes sit behind the
 * guard of whichever server forwards to them; `checkedSecret` arrives as a binding
 * because the request that was checked is the forwarding one, not this one.
 */
export function openDocument(file: string, opts: DocumentOptions, currentSecret: () => string | null) {
  let review: Review = ensureRound(file, readFileSync(file, 'utf8'));
  // What we render is the current round's snapshot, not the live file. Freezing what
  // comments attach to removes, structurally, the path where positions conflict while
  // someone is still writing.
  let snapshot = roundContent(file, review.currentRound);
  /**
   * The blocks the screen is built from.
   *
   * Held rather than rebuilt per request because the snapshot is frozen for the whole
   * round, and because this is what a comment's range is checked against: the browser
   * can only offer what is in here, so validating against it leaves no room for the
   * screen and the API to disagree about which lines can be pointed at (#101).
   */
  let doc = buildDoc(file, snapshot);
  let comments: Comment[] = loadComments(file, review.currentRound);
  let changes = 0;

  /** Each open stream, written to with a whole SSE frame. */
  const clients = new Set<(frame: string) => void>();
  /**
   * SSE is a notification channel, not a rendering channel. All it carries is
   * "the document changed". Pushing a doc payload makes the receiver rebuild the
   * screen, which destroys the reading position, the focused input, an in-flight
   * IME composition and the text selection — none of it caused by the person.
   * Rounds already say the person decides when the document changes; this applies
   * that rule to the whole screen.
   */
  const notifyChanged = () => notify(changedEvent());

  const notify = (payload: unknown) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const send of clients) send(frame);
  };

  /**
   * A comment frame on every stream, every few seconds (#71). The server closes a
   * connection idle for IDLE_TIMEOUT_S, so without it a quiet stream was dropped and
   * reopened about every 12 seconds. A client that went away is still dropped: on a clean
   * close through `cancel`, otherwise when a write fails, which for a peer gone without a
   * word waits on TCP giving up rather than on the idle timeout.
   */
  const heartbeat = setInterval(() => {
    for (const send of clients) send(': ping\n\n');
  }, HEARTBEAT_MS);

  const readLive = (): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };

  /**
   * Read the file only once it has stopped moving.
   *
   * An editing agent writes by truncating and writing back. Reading once, in between,
   * takes the empty file as the round's document — and since a round's snapshot is
   * frozen, that document then has nothing to comment on until somebody opens another
   * round (#100). The watcher already waits for quiet before it reads; this is the same
   * idea for the one read where getting it wrong is not recoverable.
   *
   * Equality of two reads is evidence, not proof — a write slower than the interval can
   * still be caught mid-way. `looksEmptied` below is the guard for the case that
   * actually happened, and it stands behind this one.
   */
  const SETTLE_TRIES = 6;
  const readSettled = async (): Promise<
    { ok: true; content: string } | { ok: false; reason: 'unreadable' | 'unsettled' }
  > => {
    let prev = readLive();
    if (prev === null) return { ok: false, reason: 'unreadable' };
    for (let i = 0; i < SETTLE_TRIES; i++) {
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const next = readLive();
      if (next === null) return { ok: false, reason: 'unreadable' };
      if (next === prev) return { ok: true, content: next };
      prev = next;
    }
    return { ok: false, reason: 'unsettled' };
  };

  /**
   * The document had text and now has none. Opening a round on that freezes an empty
   * snapshot, which is the state nothing recovers from: the file coming back does not
   * undo it, because the round already holds the empty copy.
   *
   * Deliberately not symmetric — a file that was already empty opens a round normally.
   * A blank note is a legitimate thing to review, and refusing that would trade one
   * stuck state for another.
   */
  const looksEmptied = (live: string): boolean => live.trim() === '' && snapshot.trim() !== '';

  const changedState = (): ChangedState => {
    const live = readLive();
    return { changes, dirty: live !== null && live !== snapshot };
  };

  const changedEvent = (): ChangedEvent => ({ type: 'changed', ...changedState() });

  const roundEvent = (): RoundEvent => ({ type: 'round', n: review.currentRound });

  const roundState = (): RoundState => ({
    n: review.currentRound,
    total: review.rounds.length,
    createdAt: review.rounds.find((r) => r.n === review.currentRound)?.createdAt ?? null,
    all: review.rounds.map((r) => ({ n: r.n, createdAt: r.createdAt, closedAt: r.closedAt })),
  });

  const docPayload = (): DocPayload => ({
    type: 'doc',
    doc,
    comments,
    round: roundState(),
    // Unresolved comments from earlier rounds: nothing carries over, so this is how they stay visible
    carried: carriedOver(file),
    changed: changedState(),
  });

  // Showing a past round: the document and comments exactly as they were. The snapshot
  // never changes, and a comment written on it is filed on that round.
  const historyPayload = (n: number): DocPayload => ({
    type: 'doc',
    history: true,
    doc: buildDoc(file, roundContent(file, n)),
    comments: loadComments(file, n),
    round: { ...roundState(), viewing: n },
    carried: carriedOver(file),
    changed: changedState(),
  });

  // A live change never swaps the document. We only say that it changed and leave
  // the decision to move to the next round with the person.
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A save that writes a new file and renames it over the old one leaves the watcher on
   * the old inode, which never fires again. A one-document server is restarted often
   * enough to hide that; one serving for days is not, so it watches the path afresh.
   */
  let rearmTimer: ReturnType<typeof setTimeout> | null = null;
  let rearmTries = 0;
  const rearm = (): void => {
    rearmTimer = null;
    if (disposed) return;
    watcher.close();
    try {
      watcher = watch(file, onChange);
      rearmTries = 0;
      // What changed while nothing was watching has to be read now: no event will say so.
      onChange('change');
    } catch {
      // Not back yet: the rename has not landed. Look again shortly, for a few seconds. A
      // file deleted for good is left unwatched until the document is removed and added
      // again, or the server restarts.
      if (++rearmTries < REARM_TRIES) rearmTimer = setTimeout(rearm, 200);
    }
  };
  const onChange = (event: string): void => {
    if (event === 'rename' && rearmTimer === null) rearmTimer = setTimeout(rearm, 50);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const live = readLive();
      if (live === null) return;
      // Reset the count when the contents match the round again (a bare save, or an undo)
      changes = live === snapshot ? 0 : changes + 1;
      notifyChanged();
    }, 80);
  };
  let watcher = watch(file, onChange);

  const app = new Hono<DocEnv>();

  app.get('/', (c) =>
    c.body(Bun.file(ASSETS['index.html']!).stream(), 200, { 'content-type': mimeFor('index.html') }),
  );

  app.get('/api/doc', vValidator('query', DocQuerySchema), (c) => {
    const want = c.req.valid('query').round ?? review.currentRound;
    if (want === review.currentRound) return c.json(docPayload());
    if (!review.rounds.some((r) => r.n === want)) return c.text('no such round', 404);
    return c.json(historyPayload(want));
  });

  app.get('/api/comments', (c) => c.json(comments));

  app.post('/api/comments', vValidator('json', CreateCommentSchema), (c) => {
    const { startLine, endLine, body, round } = c.req.valid('json');
    /**
     * Filed on the round the screen was showing, whichever that is. Never refused for it.
     *
     * akapen is read while an agent keeps writing: a person reviews one round while the
     * next one is cut on another screen, or goes back to an earlier round to say something
     * about it. The line numbers were read from that round's snapshot, and saving the
     * comment into that round is what keeps them pointing where the person pointed.
     * Refusing it instead throws away a review somebody already wrote and asks them to
     * write it again, which is the one thing a review tool must not do. The only refusal
     * left is a range that points at nothing.
     *
     * A client that names no round is on the current one.
     */
    const n = round ?? review.currentRound;
    const current = n === review.currentRound;
    if (!current && !review.rounds.some((r) => r.n === n)) return c.text('no such round', 404);
    const source = current ? snapshot : roundContent(file, n);
    const target = current ? doc : buildDoc(file, source);
    /**
     * The schema only knows a line number is a positive integer. Whether the range
     * points at anything depends on the document, which the schema cannot see.
     *
     * The test is the blocks, not the text. Reading the snapshot again here made the
     * server answer, from the same file, a question the browser had already answered
     * differently: a blank line inside a code block is a block of its own, is drawn,
     * gets a `+`, and was refused for holding only whitespace (#101). Letting code
     * blocks through as a special case would only move the disagreement somewhere
     * else — the blocks are what the screen offers, so they are what decides.
     *
     * A trailing newline still makes a last "line" that is not there, and a blank line
     * between two blocks still belongs to nothing. Neither is in `blocks`, so both are
     * refused without a rule of their own.
     *
     * Overlap, not coverage. A selection made in the gutter runs from one row to another
     * and takes the blank lines between them with it, so demanding that every line in the
     * range belong to a block would refuse ranges the screen offers. The end still has to
     * be a line the document has, or a range starting on real text would drag in numbers
     * past the end of the file and store them.
     */
    if (
      endLine < startLine ||
      endLine > target.lineCount ||
      !target.blocks.some((b) => b.startLine <= endLine && b.endLine >= startLine)
    ) {
      return c.text('line range does not point at any text', 400);
    }
    const comment = makeComment(source, startLine, endLine, body, opts.author);
    // Written before it is shown. Pushing first would leave a comment that only exists
    // in memory when the write fails: the POST reports failure, GET returns it anyway,
    // and the next successful save persists the one that was refused.
    const next = [...(current ? comments : loadComments(file, n)), comment];
    saveComments(file, n, next);
    opts.onWrite?.();
    if (current) comments = next;
    // Just answer. The author's own screen updates locally.
    return c.json({ comment, comments, carried: carriedOver(file) });
  });

  // resolve works on past rounds too. Freezing the status as well would leave no
  // way to close an unresolved comment, and the agent handoff would jam.
  app.post('/api/comments/:id/resolve', (c) => {
    const updated = updateComment(file, c.req.param('id'), (comment) => {
      comment.resolved = !comment.resolved;
    });
    if (!updated) return c.text('not found', 404);
    if (updated.round === review.currentRound) comments = loadComments(file, review.currentRound);
    return c.json({ comment: updated, comments, carried: carriedOver(file) });
  });

  /**
   * A reply lands on its parent wherever that parent lives, including a round that has
   * already closed. What a closed round freezes is the document and its line anchors;
   * the conversation about it is the same side of that line as `resolved`, which #4
   * already decided can still move.
   *
   * `authorKind` is stamped here rather than taken from the body. A reply is an agent's
   * when it names the Claude Code session that wrote it in `x-akapen-session`, which the
   * channel's instructions have every session send from `$CLAUDE_CODE_SESSION_ID`. A
   * browser never sends it. The header is a claim, not an identity: whoever holds the
   * token (#112) can make it, which is the trust the token already carries.
   *
   * Not decided by the credential (cookie against bearer), as #161 first suggested. That
   * tells a browser from everything else, not an agent from a person running curl, and
   * it names no session.
   */
  app.post('/api/comments/:id/replies', vValidator('json', CreateReplySchema), (c) => {
    const session = c.req.header('x-akapen-session');
    if (session !== undefined && !SESSION_ID.test(session)) return c.text('bad x-akapen-session', 400);
    const kind = session === undefined ? 'human' : 'agent';
    const added = addReply(file, c.req.param('id'), c.req.valid('json').body, opts.author, kind, session);
    if (!added) return c.text('not found', 404);
    opts.onWrite?.();
    if (added.comment.round === review.currentRound) comments = loadComments(file, review.currentRound);
    return c.json({ comment: added.comment, comments, carried: carriedOver(file) });
  });

  /**
   * One cut at a time.
   *
   * Waiting for the file to settle handed control back mid-request, which the earlier
   * synchronous handler never did. Two screens both showing the banner and both pressing
   * the button — the situation this whole change is about — then landed inside that
   * window together, and each opened a round of its own: the second one identical to the
   * first, the first one closed before a single comment could be written on it, and the
   * screen that opened it already behind.
   *
   * The second one is refused rather than queued: the round it asked for is the one
   * already being opened, and it arrives on that screen as the `round` event, same as
   * any other.
   */
  let cutting = false;
  /** Set by `stop`: this holder no longer owns the document's store. */
  let disposed = false;
  /** How to end each open stream, for `stop`. */
  const streamEnds = new Map<(frame: string) => void, () => void>();

  // A round is cut on request: by a person, or by an agent running `akapen rounds cut`. An agent's intermediate save never cuts one.
  app.post('/api/rounds', async (c) => {
    if (cutting) return c.text('a round is already being opened; it will arrive on its own', 409);
    cutting = true;
    try {
      return await cutRound(c);
    } finally {
      // Every exit releases it. One that did not would leave the document permanently
      // stuck on the round it was on, with nothing on screen saying why.
      cutting = false;
    }
  });

  const cutRound = async (c: Context) => {
    const read = await readSettled();
    // Removed or reopened while the file was settling: another holder may already have
    // the store, and opening a round from here would move it behind that one's back.
    if (disposed) return c.text('this document is no longer served here', 409);
    if (!read.ok) {
      if (read.reason === 'unreadable') return c.text('cannot read file', 500);
      // Refusing costs a click. Freezing a half-written document costs the whole file:
      // every comment on it is refused until another round is opened.
      return c.text('the file is still being written; the round was not opened', 409);
    }
    const live = read.content;
    if (looksEmptied(live)) {
      return c.text('the file is empty right now; the round was not opened', 409);
    }
    // Two people pressing the button half a second apart, after the first cut is over and
    // so past the guard above: the second reads what the first just froze. Opening a
    // round for it would close the first one before anything could be written on it, and
    // leave that screen behind. The round it asked for exists already, holding the
    // content it would have frozen, so it gets that one.
    if (live === snapshot) return c.json(docPayload());
    review = openRound(file, live);
    snapshot = live;
    doc = buildDoc(file, snapshot);
    comments = [];
    changes = 0;
    // Every other screen is still on the previous round and does not know. Telling them
    // is what stops them from sending comments against line numbers that have moved.
    // Only that it moved: rebuilding a screen nobody touched is what rounds exist to avoid.
    notify(roundEvent());
    // A new round means a new document. Return it, and only the clicker's screen swaps.
    return c.json(docPayload());
  };

  app.get('/api/rounds', (c) => c.json({ current: review.currentRound, rounds: review.rounds }));

  /** What `akapen comments` prints: every round's unresolved comments (`?all=1`: resolved too). */
  app.get('/api/pending', (c) =>
    c.json({ current: review.currentRound, comments: pendingComments(file, c.req.query('all') === '1') }),
  );

  /**
   * What this instance is showing. Small on purpose: it is answered on every liveness
   * check another instance makes, and a row only needs enough to recognise a document
   * and see whether it is waiting on someone.
   *
   * The basename, never the path. The switcher is read over the LAN with nothing
   * authenticating a reader (#10), and directory layout is not something to hand out.
   */
  app.get('/api/status', (c) => {
    const status: StatusPayload = {
      file: basename(file),
      // `doc` is the round being shown, not the file: a heading edited on disk is reported
      // once a round is closed on it, the same moment the tab picks it up.
      title: documentTitle(doc),
      round: review.currentRound,
      // Across every round, matching `akapen comments`: closing a round hands the
      // unresolved ones over, so they are still what the document is waiting on.
      unresolved: pendingComments(file).length,
    };
    return c.json(status);
  });

  app.get('/events', (c) => {
    // Let in under this token. A rotation revokes it, and with the heartbeat keeping the
    // stream open nothing else would, so the next frame closes the stream instead. Taken
    // from the check that let the request in: reading the token again here could see a
    // rotation that check did not, and a stream let in on the old token would then
    // outlive it.
    //
    // No test pins this choice: telling it apart from a second `currentSecret()` needs
    // the one-second cache to run out between the middleware and this line, inside one
    // request, and the suite drives the server as a separate process (#244).
    const openedUnder = c.env.checkedSecret;
    let send!: (frame: string) => void;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        send = (frame: string) => {
          try {
            if (currentSecret() !== openedUnder) {
              clients.delete(send);
              controller.close();
              return;
            }
            controller.enqueue(enc.encode(frame));
          } catch {
            clients.delete(send);
          }
        };
        clients.add(send);
        streamEnds.set(send, () => {
          try {
            controller.close();
          } catch {
            /* Already closed by the reader. */
          }
        });
        // The first render comes from /api/doc on load. Sending a doc here would
        // rebuild the screen on every reconnect.
        send(`data: ${JSON.stringify(changedEvent())}\n\n`);
      },
      cancel() {
        clients.delete(send);
        streamEnds.delete(send);
      },
    });
    // Hono's streamSSE owns the lifetime of the handler, but this stream outlives the
    // request and is written to from the file watcher, so the Response is built here.
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  });
  /**
   * An image the document refers to. Every refusal is the same 404, so the answer does
   * not tell a reader what exists outside the root.
   *
   * Images are not frozen with a round, so a diagram re-exported beside the document
   * has to show when the page next asks for it. `no-cache` makes the browser ask, and
   * the ETag keeps that asking to a 304 instead of the whole file each time.
   *
   * The SVG headers are for someone opening this URL directly: from an `<img>` its
   * script never runs, but as a document it would run on this origin, with the cookie.
   */
  const fileRoot = resolve(opts.root ?? dirname(file));
  app.get(FILE_ROUTE, (c) => {
    const found = resolveDocumentFile(file, fileRoot, c.req.query('path') ?? '');
    if (found === null) return c.text('not found', 404);
    const st = statSync(found, { throwIfNoEntry: false });
    if (st === undefined) return c.text('not found', 404);

    // Full precision: a same-size re-export within one millisecond must still change it.
    const etag = `"${st.size}-${st.mtimeMs}"`;
    const cache = { etag, 'cache-control': 'no-cache' };
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, cache);
    // Set by hand: Bun answers HEAD on a streamed body with a length of 0.
    return c.body(Bun.file(found).stream(), 200, {
      ...cache,
      'content-type': imageMime(found),
      'content-length': String(st.size),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
  });

  /** Everything this document holds open. The socket is the server's, not its. */
  const stop = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    clearInterval(heartbeat);
    disposed = true;
    if (rearmTimer) clearTimeout(rearmTimer);
    watcher.close();
    // Ended rather than dropped, so a page reading a document that is no longer served
    // sees its stream close at once instead of waiting on the connection to time out.
    for (const end of streamEnds.values()) end();
    streamEnds.clear();
    clients.clear();
  };

  return { app, stop, file, round: () => review.currentRound };
}

export type OpenDocument = ReturnType<typeof openDocument>;

type GuardOptions = Pick<ServeOptions, 'host' | 'token' | 'tokenPinned' | 'cssPath' | 'keymapPath'>;

/**
 * The parts of a server that are not about any one document: the Host, site and token
 * checks in front of everything, and the stylesheet and keymap hooks.
 *
 * `rememberUrl` is told the origin a browser logged in on.
 */
function guardedApp(opts: GuardOptions, rememberUrl: (url: string) => void) {
  /**
   * `checkedSecret` is the secret this request was checked against, or null when nothing
   * is checked. A handler only runs once it has matched, so there it is the secret the
   * request was let in on. Handlers that hold on to it read it from here rather than
   * asking `currentSecret()` again, which may have moved on since (#244).
   *
   * It is set past the Host and site checks, so a route registered ahead of the
   * authentication middleware, or an early return added before the `set`, would read
   * `undefined` here — and a stream comparing that with the current secret closes at once.
   */
  const app = new Hono<{ Variables: { checkedSecret: string | null } }>();

  const token = opts.token;

  /**
   * The secret to check against right now.
   *
   * Re-read rather than captured, so that rotating the stored token locks out the
   * cookies and scripts holding the old one without waiting for a restart. Cached for a
   * moment because this is on the path of every request, including each asset.
   *
   * A store that has become unreadable keeps the last value read from it rather than
   * locking everyone out: a read that fails should not end a review in progress. Not the
   * startup value: after a rotation it is revoked, and falling back to it would let the
   * old token in again and close every stream opened since (#244).
   */
  let secretAt = 0;
  let secret = token;
  const currentSecret = (): string | null => {
    if (token === null || opts.tokenPinned) return token;
    const now = Date.now();
    if (now - secretAt >= 1_000) {
      secretAt = now;
      secret = readToken() ?? secret;
    }
    return secret;
  };

  /**
   * The names we answer to, rebuilt when one is not recognised.
   *
   * Under a wildcard bind the set is the machine's own addresses, and those change
   * underneath a running process: joining a VPN or moving to another network gives it an
   * address it did not have at startup, and every request to that address would be a 403
   * with nothing wrong. Rebuilding only on a miss keeps the syscall off the common path,
   * and the interval keeps a stream of unknown Hosts from turning into a stream of them.
   */
  let allowed = allowedHostnames(opts.host);
  let rebuiltAt = 0;
  const serves = (name: string): boolean => {
    if (allowed.has(name)) return true;
    const now = Date.now();
    if (now - rebuiltAt < 1_000) return false;
    rebuiltAt = now;
    allowed = allowedHostnames(opts.host);
    return allowed.has(name);
  };

  /**
   * Everything below this is behind it, assets and SSE included.
   *
   * Three ways in, one secret. The cookie is the steady state; the query is the first
   * visit and the bookmark; the bearer header is curl and an agent, which get no cookie
   * because they keep no jar.
   *
   * The redirect after the query is what makes it seamless: the token leaves the address
   * bar and the history entry, and the browser holds it from then on, so every later
   * visit is the bare URL. The bookmark keeps its copy, which is how a cleared cookie or
   * a second browser recovers without anyone going to look for a URL.
   */
  /**
   * Set on the way out, so it reaches every answer.
   *
   * Setting it before `next()` misses both ends: the host refusal returns above it, and
   * `/events` builds its own `Response`, which nothing set on the context is merged into.
   * The token rides in a URL, so this is worth being true of everything rather than of
   * the handlers that happen to use `c.json`.
   */
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('referrer-policy', 'no-referrer');
  });

  app.use('*', async (c, next) => {
    /**
     * HTTP/1.1 requires a Host, and the name check below is the whole rebinding defence,
     * so an absent one is refused rather than waved through as "not a foreign name".
     *
     * Unreachable as things stand: Bun answers a Host-less HTTP/1.1 request with a 500
     * before any of this runs, which is why there is no test for it — one would pass
     * with the branch removed and would be pinning nothing. It is here so that the rule
     * is the rule, rather than something the runtime happens to be enforcing for us.
     */
    const host = c.req.header('host');
    if (host === undefined || !serves(hostnameOf(host))) {
      return c.text('host not served here', 403);
    }

    /**
     * A write has to come from akapen's own page.
     *
     * The cookie is not enough on its own, because cookies are not isolated by port and
     * neither is `SameSite`: anything served from another port on this host is the same
     * *site*, so the browser attaches the cookie to its requests here. A `POST` with no
     * body is a CORS-simple request, so no preflight stands in the way either — a page
     * on `localhost:8080` could cut a round on `localhost:4300` and the reader would
     * find their document had moved under them. It could not read the answer, since
     * nothing here sends CORS headers, but the damage is in the doing.
     *
     * `Sec-Fetch-Site` is what closes it, rather than comparing `Origin` with `Host`:
     * the browser works it out from what it sees, so a TLS-terminating proxy in front —
     * the arrangement `--no-auth` exists for — still reads as `same-origin`, where
     * comparing the two headers would refuse every write.
     *
     * Absent means a client that is not a browser, which is curl and agents, and they
     * carry a bearer token instead. Browsers older than the header are not covered.
     */
    if (!SAFE_METHODS.has(c.req.method)) {
      const site = c.req.header('sec-fetch-site');
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        return c.text('a write has to come from akapen itself', 403);
      }
    }
    const active = currentSecret();
    c.set('checkedSecret', active);
    if (active === null) return next();

    const cookie = getCookie(c, COOKIE);
    const cookieOk = cookie !== undefined && tokensMatch(cookie, active);

    const url = new URL(c.req.url);
    const presented = url.searchParams.get('token');
    const queryOk = presented !== null && tokensMatch(presented, active);

    /**
     * A token in the URL is taken back out of it, on every visit and not only the first.
     *
     * Checking the cookie first and answering there would leave the bookmark — which
     * keeps its `?token=` on purpose — putting the secret back in the address bar and in
     * a fresh history entry every time it is opened, once the browser already had a
     * cookie. The whole point of the redirect is that the URL somebody copies out of the
     * bar is not the credential, and it only held on the very first visit.
     *
     * The cookie is only written when the query itself was right. A bookmark holding a
     * rotated-away token, opened by a browser whose cookie is still good, is redirected
     * without that stale value being stored.
     *
     * Only for methods that read. Redirecting a POST loses its body, and a `?token=` on
     * one is a credential rather than something a person is about to bookmark.
     */
    if (presented !== null && (cookieOk || queryOk) && SAFE_METHODS.has(c.req.method)) {
      if (queryOk) {
        /**
         * The authority the cookie is about to be scoped to, which is the one this
         * browser can come back on. Taken from the request rather than derived: what
         * was bound, what `--advertise` named and what the reader typed are three
         * different things, and only the last one is what the cookie will follow.
         *
         * Already checked — a `Host` this server does not serve was refused above — so
         * what is recorded here is a name it answers to.
         */
        if (host !== undefined) rememberUrl(`http://${host}`);
        setCookie(c, COOKIE, active, {
          httpOnly: true,
          sameSite: 'Lax',
          path: '/',
          // Without this it is a session cookie, and "every visit after is the bare URL"
          // would last until the browser is closed. The token does not expire, so an
          // expiry here would not be protecting anything — only asking again.
          maxAge: 60 * 60 * 24 * 365,
          // No `secure`: the transport is plain HTTP, and a Secure cookie sent over it
          // is simply never stored, turning the whole flow into a redirect loop.
        });
      }
      url.searchParams.delete('token');
      /**
       * Relative, and to a path that cannot be read as an authority.
       *
       * `//evil.example/x` is a scheme-relative URL, not a path: a browser sent there
       * leaves for `evil.example`. A request for `GET //evil.example/x?token=...` gives
       * exactly that pathname, so echoing it back turns this redirect into an open
       * one — the token is stripped by then, so nothing leaks, but the reader lands
       * somewhere chosen by whoever sent them the link.
       */
      const path = url.pathname.replace(/^\/+/, '/');
      return c.redirect(`${path}${url.search}`, 302);
    }

    if (cookieOk || queryOk) return next();

    // The scheme is case-insensitive (RFC 7235 §2.1), and a client sending `bearer`
    // is right while a 401 telling it otherwise is not.
    const auth = c.req.header('authorization') ?? '';
    const bearer = /^bearer /i.test(auth) ? auth.slice('bearer '.length) : null;
    if (bearer !== null && tokensMatch(bearer, active)) return next();

    return c.text('unauthenticated. open the URL akapen printed, or run `akapen token`', 401, {
      // What a 401 owes the client: which scheme would have worked (RFC 7235 §3.1).
      'www-authenticate': 'Bearer',
    });
  });

  // Extra CSS. crit had no such hook; open one from the start.
  app.get('/custom.css', (c) => {
    const css = opts.cssPath && existsSync(opts.cssPath) ? readFileSync(opts.cssPath, 'utf8') : '';
    return c.body(css, 200, { 'content-type': 'text/css; charset=utf-8' });
  });

  // Keymap override. Like the CSS hook, a way to configure it from the start.
  // A broken JSON must not make the tool unusable, so fall back to the defaults.
  app.get('/keymap.json', (c) => {
    let body = '{}';
    if (opts.keymapPath && existsSync(opts.keymapPath)) {
      const raw = readFileSync(opts.keymapPath, 'utf8');
      try {
        JSON.parse(raw);
        body = raw;
      } catch {
        console.error(`akapen: keymap JSON is invalid; continuing with the defaults: ${opts.keymapPath}`);
      }
    }
    return c.body(body, 200, { 'content-type': 'application/json' });
  });
  return { app, currentSecret };
}

type GuardedApp = ReturnType<typeof guardedApp>['app'];

/** Hand a request to a document's routes, under the path it has inside the document. */
function forward(c: Context, doc: OpenDocument, path: string): Response | Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = path;
  return doc.app.fetch(new Request(url, c.req.raw), {
    checkedSecret: c.get('checkedSecret') as string | null,
  });
}

function serveAssets(app: GuardedApp): void {
  // Only what ASSETS names is served here. No directory walking means this route has no
  // path traversal to begin with (the file route above has its own containment), and it
  // works unchanged inside the single binary.
  app.get('*', (c) => {
    const path = new URL(c.req.url).pathname;
    const name = path === '/' ? 'index.html' : path.slice(1);
    const asset = ASSETS[name];
    if (!asset) return c.text('not found', 404);
    return c.body(Bun.file(asset).stream(), 200, { 'content-type': mimeFor(name) });
  });
}

export function startServer(opts: ServeOptions) {
  const file = resolve(opts.file);
  // Read once. It cannot change while the process runs, and the login handler below
  // needs it on a path that should not be touching the environment.
  const origin = detectOrigin();

  /**
   * Say where this instance can be reached, if anybody is going to look.
   *
   * Written twice over a life. Once when the socket is listening, with the address the
   * startup line printed — so a session that has just started one has something to show
   * before anybody has opened it. Again when a browser logs in, with the origin that
   * browser now holds a cookie for.
   *
   * The second is what makes the first safe. The recorded url is a guess at which of
   * this machine's addresses the reader will use, and a cookie is scoped to scheme, host
   * and port together — so a wrong guess is one a bare url cannot come back on. But a
   * wrong guess is also, precisely, one whose cookie will not be sent, which forces a
   * login, which rewrites it. It repairs itself in the case it is wrong, and only then.
   *
   * Guarded on the value because a bookmark carrying `?token=` logs in on every visit,
   * and rewriting an identical file on every reload is a write nobody asked for.
   */
  let recordedUrl: string | null = null;
  const rememberUrl = (url: string): void => {
    if (origin.id === undefined || url === recordedUrl) return;
    // Cached only once it is on disk. Caching the attempt would mean a write that failed
    // — a directory removed underneath it, a full disk — is never tried again, and the
    // login that would have repaired a wrong guess returns early instead.
    if (recordUrl(origin.id, process.pid, url)) recordedUrl = url;
  };

  const { app, currentSecret } = guardedApp(opts, rememberUrl);
  const document = openDocument(
    file,
    { author: opts.author, ...(opts.root === undefined ? {} : { root: opts.root }) },
    currentSecret,
  );

  /**
   * The other akapen running for this user, built here rather than in the browser.
   *
   * The browser cannot do it. Every instance is a different origin, so it would need
   * CORS on an endpoint that has none, and one bound to `127.0.0.1` is not reachable
   * from the reader's machine at all while being perfectly reachable from here.
   *
   * Without sweeping: a server outlives an upgrade as a channel does, and this runs on
   * every focus of the page, so an old one would delete what a newer one registers (#184).
   */
  app.get('/api/instances', async (c) => {
    const live = await liveInstances({ sweep: false, excludePid: process.pid, token: currentSecret() });
    const payload: InstancesPayload = {
      instances: live.map(({ record, status }) => ({
        pid: record.pid,
        host: record.host,
        port: record.port,
        file: status.file,
        round: status.round,
        unresolved: status.unresolved,
        // A loopback bind answers here, next to it, and nowhere the reader's browser
        // can reach. Saying so beats a link that times out.
        reachable: !isLoopback(record.host),
      })),
    };
    return c.json(payload);
  });
  // The document is mounted at the root: one process, one document.
  app.get('/', (c) => forward(c, document, '/'));
  app.all('/api/*', (c) => forward(c, document, new URL(c.req.url).pathname));
  app.get('/events', (c) => forward(c, document, '/events'));
  app.get(FILE_ROUTE, (c) => forward(c, document, FILE_ROUTE));
  serveAssets(app);

  // One process, as before. Hono only replaces the routing inside the same fetch
  // handler; there is no second server and nothing to proxy.
  const serve = (port: number) =>
    Bun.serve({ hostname: opts.host, port, idleTimeout: IDLE_TIMEOUT_S, fetch: app.fetch });
  let server: ReturnType<typeof serve>;
  let movedFrom: number | null = null;
  try {
    server = serve(opts.port);
  } catch (err) {
    if (!opts.fallBackIfTaken || (err as { code?: unknown }).code !== 'EADDRINUSE') throw err;
    server = serve(0);
    movedFrom = opts.port;
  }

  // Announced only once it is listening, and with the port the socket actually got —
  // `-p 0` means the number in opts is 0, which nothing can be reached on.
  //
  // Bun leaves the port undefined for a server listening on a unix socket. This one
  // never is, and an entry without a port is an entry nothing can be reached through,
  // so there would be nothing to write.
  if (server.port !== undefined) {
    registerInstance({
      pid: process.pid,
      host: opts.host,
      port: server.port,
      file,
      startedAt: new Date().toISOString(),
      origin,
    });
    // The same derivation the startup line prints, so the two never disagree.
    rememberUrl(urlsFor(opts.advertised ?? opts.host, server.port)[0]);
    // A crash leaves a file behind that nothing will ever remove on its own, and one
    // that never looks wrong: whoever reads it checks the pid and skips it. Starting is
    // when the registry has just been read anyway, so it is the cheapest moment to look.
    sweepSessions(liveEntries());
  }

  /**
   * Shut everything this started, not just the socket.
   *
   * The CLI never needs it — the process exits and takes the watcher with it. Anything
   * that starts a server and keeps running does need it: `server.stop()` alone leaves
   * the FSWatcher and a pending debounce timer holding the event loop open.
   */
  const stop = async () => {
    document.stop();
    // Before the socket closes: an entry left pointing at a port nobody is listening on
    // is what every reader then has to spend a timeout discovering.
    removeInstance();
    if (origin.id !== undefined) forgetUrl(origin.id, process.pid);
    await server.stop(true);
  };

  return { server, stop, storeDir: storeDir(file), round: document.round(), movedFrom };
}

export type DaemonOptions = Omit<ServeOptions, 'file' | 'root' | 'fallBackIfTaken'>;

/**
 * How long a session's channel may be gone before its registrations are removed (#305).
 * Long enough to ride out a channel restarting; `AKAPEN_DISCONNECT_MS` is for the tests.
 */
const DISCONNECT_MS = ((): number => {
  const asked = Number(process.env['AKAPEN_DISCONNECT_MS']);
  return Number.isInteger(asked) && asked > 0 ? asked : 30_000;
})();

const AddDocumentSchema = v.object({
  file: v.pipe(v.string(), v.minLength(1)),
  root: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/** The peers the management API answers: the CLI on this machine. */
const isLoopbackPeer = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

/**
 * A request that came through a proxy on this machine arrives from loopback too, on behalf
 * of whoever reached the proxy. Proxies that say so in these headers are refused here.
 * One that does not is stopped by the management secret, which it does not have.
 */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip'];
const fromThisMachine = (c: Context): boolean =>
  isLoopbackPeer(getConnInfo(c).remote.address) &&
  FORWARDING_HEADERS.every((h) => c.req.header(h) === undefined);

/** The URL path of a document. The id is a file name, which may hold `#`, `%` or a space. */
const pathOf = (id: string): string => `/d/${encodeURIComponent(id)}/`;

/** A registration refused for something wrong with what was asked. */
const bad = (refused: string) => ({ refused, status: 400 as const });

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/**
 * One long-lived process serving every registered document under `/d/<id>/` (#305).
 *
 * Documents are opened on their first request rather than on registration, so a
 * registered document nobody has read holds no watcher. Once opened, one stays open until
 * it is removed: a file watcher and a 3-second heartbeat timer each. The registry is written here
 * and only here: the CLI goes through `/api/documents`, which makes this the single
 * writer of `documents.json`.
 */
export function startDaemon(opts: DaemonOptions & { manageToken: string }) {
  const { manageToken } = opts;
  // Before anything reads a store: the documents' comments move to comments/ (#305).
  const notRenamed = renameLegacyStore(readInstances({ sweep: false }).length > 0);
  if (notRenamed !== null) console.error(`akapen: ${notRenamed}`);
  const { app, currentSecret } = guardedApp(opts, () => {});
  let entries: DocumentEntry[] = readDocuments();
  const open = new Map<string, OpenDocument>();
  let base = '';

  const close = (id: string): void => {
    open.get(id)?.stop();
    open.delete(id);
  };

  const documentFor = (id: string): OpenDocument | null => {
    const entry = entries.find((e) => e.id === id);
    if (entry === undefined) return null;
    let doc = open.get(id);
    // One already open keeps answering while the file is briefly gone: an editor that
    // replaces it by delete and create must not turn a comment on the round into a 404.
    if (doc === undefined) {
      if (!existsSync(entry.file)) return null;
      doc = openDocument(
        entry.file,
        {
          author: opts.author,
          ...(entry.root === undefined ? {} : { root: entry.root }),
          // Looked up when it fires: registering again may have handed the document to another session.
          onWrite: () => notifySession(entries.find((e) => e.id === id)?.session),
        },
        currentSecret,
      );
      open.set(id, doc);
    }
    return doc;
  };

  /** A row of `GET /api/documents`. Read from the store, so listing opens nothing. */
  const describe = (e: DocumentEntry) => {
    const missing = !existsSync(e.file);
    const round = missing ? 0 : loadReview(e.file).currentRound;
    let title: string | null = null;
    if (!missing && round > 0) {
      try {
        title = documentTitle(buildDoc(e.file, roundContent(e.file, round)));
      } catch {
        /* A round that cannot be read: listed without a title rather than not at all. */
      }
    }
    return {
      id: e.id,
      file: e.file,
      session: e.session ?? null,
      url: `${base}${pathOf(e.id)}`,
      title,
      round,
      unresolved: missing ? 0 : pendingComments(e.file).length,
      missing,
      added_at: e.addedAt,
    };
  };

  const save = (next: DocumentEntry[]): void => {
    writeDocuments(next);
    entries = next;
  };

  /** Each session's open channel streams, and the timer that removes its registrations once they are all gone. */
  const streams = new Map<string, Set<(frame: string) => void>>();
  const gone = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bumped by restore: a stream opened before it cannot start the removal of the resumed session. */
  const generation = new Map<string, number>();
  /** How to end each session stream, so restore can close the ones it retires. */
  const sessionStreamEnds = new WeakMap<(frame: string) => void, () => void>();
  let stopping = false;
  const notifySession = (session: string | undefined): void => {
    if (session === undefined) return;
    for (const send of streams.get(session) ?? []) send('data: changed\n\n');
  };
  const heartbeat = setInterval(() => {
    for (const set of streams.values()) for (const send of set) send(': ping\n\n');
  }, HEARTBEAT_MS);

  /** Unregister everything a session registered. Its registration records stay, for `restore`. */
  const forget = (session: string): string[] => {
    const removed = entries.filter((e) => e.session === session).map((e) => e.id);
    // Written before anything is closed, so a write that fails leaves the documents serving.
    if (removed.length > 0) save(entries.filter((e) => e.session !== session));
    for (const id of removed) close(id);
    return removed;
  };

  /**
   * Registering a file hands out its contents, so only the CLI on this machine may do it.
   * Whoever holds the token on the LAN can read and comment on what is registered; letting
   * them register `~/.ssh/id_ed25519` as well would make the token a key to every file.
   * Listing is held to the same peers because it carries full paths.
   */
  // The wildcard matches `/api/documents` itself as well.
  app.use('/api/documents/*', async (c, next) => {
    if (!fromThisMachine(c)) {
      return c.text('documents are managed from this machine only', 403);
    }
    const presented = c.req.header('x-akapen-manage');
    if (presented === undefined || !tokensMatch(presented, manageToken)) {
      return c.text(
        "the management secret is missing or wrong (manage-token in akapen's home, or AKAPEN_MANAGE_TOKEN)",
        403,
      );
    }
    return next();
  });

  app.get('/api/documents', (c) => c.json(entries.map(describe)));

  /**
   * Register a document, or update the registration it already has. The same path always
   * gets the same id, so registering again is how a resumed session gets its URL back.
   */
  const register = (
    file: string,
    session: string | undefined,
    root: string | undefined,
    since?: string,
  ): DocumentEntry | { refused: string; status: 400 | 409 } => {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return bad(`no such file: ${file}`);
    if (root !== undefined) {
      if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
        return bad(`root is not a directory: ${root}`);
      if (!isInside(realpathSync(root), realpathSync(file)))
        return bad(`root does not contain the document: ${root}`);
    }
    // A one-document akapen on the same file holds the round and comments in memory and
    // writes them back, as this server would: two holders of one store overwrite each other.
    if (readInstances({ sweep: false }).some((r) => r.file === file)) {
      return { refused: `a one-document akapen is serving ${file}; stop it first`, status: 409 };
    }
    const id = documentId(file);
    const prev = entries.find((e) => e.id === id);
    // Registered again from a shell, it keeps the session it had: that session's channel
    // still wants its comments. From another session, it moves to that one.
    const owner = session ?? prev?.session;
    // The same for the root: registering again without one is not asking to drop it.
    const kept = root ?? prev?.root;
    const entry: DocumentEntry = {
      id,
      file,
      ...(owner === undefined ? {} : { session: owner }),
      ...(kept === undefined ? {} : { root: kept }),
      // A restored registration keeps when it was first made: the channel takes a comment
      // written since then as new, including one written while the session was away.
      addedAt: prev?.addedAt ?? since ?? new Date().toISOString(),
    };
    // Written before anything is closed, so a write that fails leaves the document serving.
    save([...entries.filter((e) => e.id !== id), entry]);
    // A root that changed takes effect by closing the open copy: the next request opens it again with the new root.
    if (prev?.root !== entry.root) close(id);
    if (owner !== undefined)
      writeRegistration({
        file,
        session: owner,
        addedAt: entry.addedAt,
        ...(kept === undefined ? {} : { root: kept }),
      });
    return entry;
  };

  app.post('/api/documents', vValidator('json', AddDocumentSchema), (c) => {
    const session = c.req.header('x-akapen-session');
    if (session !== undefined && !SESSION_ID.test(session)) return c.text('bad x-akapen-session', 400);
    const body = c.req.valid('json');
    const added = register(
      resolve(body.file),
      session,
      body.root === undefined ? undefined : resolve(body.root),
    );
    if ('refused' in added) return c.text(added.refused, added.status);
    return c.json(describe(added));
  });

  app.delete('/api/documents/:id', (c) => {
    const id = c.req.param('id');
    const entry = entries.find((e) => e.id === id);
    if (entry === undefined) return c.text('not registered', 404);
    save(entries.filter((e) => e.id !== id));
    close(id);
    // Removed on purpose: a resume of its session does not bring it back.
    forgetRegistration(entry.file);
    return c.json({ removed: [id] });
  });

  /** Every registration a session made, for the hook that runs when it ends. */
  app.delete('/api/documents', (c) => {
    const session = c.req.query('session');
    if (session === undefined || !SESSION_ID.test(session))
      return c.text('name a session: ?session=<id>', 400);
    return c.json({ removed: forget(session) });
  });

  /**
   * A session's channel, on this machine: what it may read, and the stream that wakes it.
   * Held to the same rule as `/api/documents`: these carry full paths and every comment,
   * and `restore` registers files.
   */
  app.use('/api/sessions/*', async (c, next) => {
    if (!fromThisMachine(c)) return c.text('sessions are this machine only', 403);
    const presented = c.req.header('x-akapen-manage');
    if (presented === undefined || !tokensMatch(presented, manageToken)) {
      return c.text(
        "the management secret is missing or wrong (manage-token in akapen's home, or AKAPEN_MANAGE_TOKEN)",
        403,
      );
    }
    // The wildcard route has no named parameter: the id is the segment after /api/sessions/.
    let session: string;
    try {
      session = decodeURIComponent(new URL(c.req.url).pathname.split('/')[3] ?? '');
    } catch {
      return c.text('bad session id', 400);
    }
    if (!SESSION_ID.test(session)) return c.text('bad session id', 400);
    return next();
  });

  /**
   * What a session's channel reads on each pass: its documents and their unresolved
   * comments, as `akapen channel` read them off disk before the server owned the store.
   */
  app.get('/api/sessions/:session/documents', (c) => {
    const session = c.req.param('session');
    return c.json(
      entries
        .filter((e) => e.session === session && existsSync(e.file))
        .map((e) => Object.assign(describe(e), { comments: pendingComments(e.file) })),
    );
  });

  /**
   * Held open by a session's channel. It carries `changed` whenever a comment or a reply
   * lands on one of the session's documents, so the channel looks at once instead of on
   * its next pass.
   *
   * It is also how the server knows the session is still there. When its last stream has
   * been closed for DISCONNECT_MS, its registrations are removed: a session killed without
   * its SessionEnd hook running would otherwise keep its documents served for ever. Only a
   * session whose channel connected at least once is ever removed this way, so one that
   * never loads the channel keeps its registrations until something removes them.
   */
  app.get('/api/sessions/:session/events', (c) => {
    const session = c.req.param('session');
    const set = streams.get(session) ?? new Set<(frame: string) => void>();
    streams.set(session, set);
    clearTimeout(gone.get(session));
    gone.delete(session);
    const openedIn = generation.get(session) ?? 0;
    let send!: (frame: string) => void;
    let dropped = false;
    const drop = () => {
      // A failed send and the stream's cancel both land here for one disconnect.
      if (dropped) return;
      dropped = true;
      set.delete(send);
      if (set.size > 0) return;
      if (streams.get(session) === set) streams.delete(session);
      // A server shutting down keeps what is registered, as a crash would, for restore.
      if (stopping || (generation.get(session) ?? 0) !== openedIn) return;
      clearTimeout(gone.get(session));
      gone.set(
        session,
        setTimeout(() => {
          gone.delete(session);
          try {
            forget(session);
          } catch (err) {
            console.error(
              `akapen: could not unregister session ${session}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }, DISCONNECT_MS),
      );
    };
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        send = (frame: string) => {
          try {
            controller.enqueue(enc.encode(frame));
          } catch {
            drop();
          }
        };
        set.add(send);
        sessionStreamEnds.set(send, () => {
          try {
            controller.close();
          } catch {
            /* Already closed by the reader. */
          }
        });
        send(': connected\n\n');
      },
      cancel: drop,
    });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
    });
  });

  /**
   * Register again what a session registered last, for its SessionStart hook on resume.
   * The URLs come back as they were, since they follow from the paths.
   */
  app.post('/api/sessions/:session/restore', (c) => {
    const session = c.req.param('session');
    const restored: ReturnType<typeof describe>[] = [];
    const refused: { file: string; reason: string }[] = [];
    // The session is back: a removal its old channel's disconnect started, or will start
    // when that stream closes, no longer applies.
    clearTimeout(gone.get(session));
    gone.delete(session);
    generation.set(session, (generation.get(session) ?? 0) + 1);
    // Streams from before keep their own set: one opened after starts a fresh one, so an old
    // stream that is still open cannot hold back the removal when the new one closes.
    // Closed rather than left open: a channel still connected reconnects into the fresh set,
    // where comments wake it again.
    for (const send of streams.get(session) ?? []) sessionStreamEnds.get(send)?.();
    streams.delete(session);
    for (const reg of registrationsOf(session)) {
      try {
        const added = register(reg.file, session, reg.root, reg.addedAt);
        if ('refused' in added) refused.push({ file: reg.file, reason: added.refused });
        else restored.push(describe(added));
      } catch (err) {
        // One file that cannot be read does not stop the others.
        refused.push({ file: reg.file, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return c.json({ restored, refused });
  });

  // The page's switcher asks this. It lists other processes, and every document here is
  // in this one, so it stays empty; the index at `/` is where the others are listed.
  app.get('/api/instances', (c) => c.json({ instances: [] } satisfies InstancesPayload));

  /**
   * What is registered, for a browser. The basename and the title, never the path: this
   * page is read over the LAN, and directory layout is not something to hand out.
   */
  app.get('/', (c) => {
    const rows = entries
      .map(describe)
      .toSorted(
        (a, b) => Number(b.unresolved > 0) - Number(a.unresolved > 0) || b.added_at.localeCompare(a.added_at),
      );
    const items = rows
      .map(
        (r) =>
          // An empty title would leave nothing to click.
          `<li><a href="${escapeHtml(pathOf(r.id).slice(1))}">${escapeHtml(r.title || basename(r.file))}</a> ` +
          `<span>${escapeHtml(basename(r.file))} · R${String(r.round).padStart(3, '0')} · ${r.unresolved} unresolved${r.missing ? ' · missing' : ''}</span></li>`,
      )
      .join('\n');
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>akapen</title><link rel="stylesheet" href="/style.css"></head>` +
        `<body><main class="documents"><h1>akapen</h1><ul>${items || '<li>nothing registered</li>'}</ul></main></body></html>`,
    );
  });

  // Without the slash, the page's relative requests would resolve one level up.
  app.get('/d/:id', (c) => c.redirect(`${pathOf(c.req.param('id'))}${new URL(c.req.url).search}`, 301));
  app.all('/d/:id/*', (c) => {
    const id = c.req.param('id');
    const doc = documentFor(id);
    if (doc === null) return c.text('not registered here', 404);
    // Cut from the raw path: the id arrives decoded, and its encoded form is longer.
    return forward(c, doc, new URL(c.req.url).pathname.replace(/^\/d\/[^/]*/, '') || '/');
  });

  serveAssets(app);

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: IDLE_TIMEOUT_S,
    fetch: app.fetch,
  });
  base = urlsFor(opts.advertised ?? opts.host, server.port ?? opts.port)[0]!;
  if (server.port !== undefined) writeServePort(server.port);

  const stop = async (): Promise<void> => {
    for (const id of open.keys()) close(id);
    clearInterval(heartbeat);
    stopping = true;
    for (const timer of gone.values()) clearTimeout(timer);
    rmSync(servePath(), { force: true });
    await server.stop(true);
  };

  return { server, stop, url: base };
}
