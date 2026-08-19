import { readFileSync, watch, existsSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { basename, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { vValidator } from '@hono/valibot-validator';
import { ASSETS, mimeFor } from './assets.ts';
import { buildDoc } from '@akapen/core/blocks';
import { readToken, tokensMatch } from '@akapen/core/token';
import {
  addReply,
  carriedOver,
  ensureRound,
  loadComments,
  makeComment,
  openRound,
  pendingComments,
  roundContent,
  saveComments,
  storeDir,
  updateComment,
  type Comment,
  type Review,
} from '@akapen/core/store';
import { liveInstances, registerInstance, removeInstance } from '@akapen/core/instances';
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

export type ServeOptions = {
  file: string;
  host: string;
  port: number;
  author: string;
  cssPath?: string;
  keymapPath?: string;
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

/**
 * The hostnames this instance answers to.
 *
 * A token says who on the network may connect. It says nothing about the attack that
 * makes "it only listens on loopback" untrue: a page the reader visits can point its own
 * hostname at `127.0.0.1` after loading — DNS rebinding — and the browser then treats
 * akapen as that page's origin, attaches the cookie itself and lets the page read the
 * answer. Being `HttpOnly` changes nothing; the browser is the one holding it.
 *
 * What the attacker cannot do is choose the `Host` header — it is forbidden to scripts —
 * so refusing every name akapen is not actually serving closes the whole class.
 *
 * A wildcard bind answers on every interface, so every local address is a real name for
 * it. The machine's own hostname is included because reaching it that way is normal
 * (`http://mcdev:4300`), and an attacker who can put that name in a browser's address
 * bar already controls this network's DNS.
 */
function allowedHostnames(bind: string): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  const wildcard = bind === '0.0.0.0' || bind === '::' || bind === '[::]';
  if (wildcard) {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list ?? []) {
        names.add(ni.address.toLowerCase());
        if (ni.family === 'IPv6') names.add(`[${ni.address.toLowerCase()}]`);
      }
    }
  } else {
    names.add(bind.toLowerCase());
  }
  const self = hostname().toLowerCase();
  names.add(self);
  // `mcdev` and `mcdev.local` are the same machine, and which one gets typed is the
  // resolver's business, not ours.
  const short = self.split('.')[0];
  if (short) names.add(short);
  return names;
}

/**
 * The name out of a `Host` header, without the port.
 *
 * The port is deliberately not checked. Cookies are not isolated by port anyway
 * (RFC 6265 §8.5), so a per-port rule would suggest a separation that does not exist.
 */
function hostnameOf(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    return close === -1 ? value : value.slice(0, close + 1);
  }
  const colon = value.lastIndexOf(':');
  const name = colon === -1 ? value : value.slice(0, colon);
  // `localhost.` is the same name as `localhost` — the trailing dot is the root of the
  // DNS tree spelled out. Some clients send it, and refusing them would be a 403 with
  // nothing wrong on the other end.
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

/** Methods that only read. A cross-origin one of these cannot be read back without CORS. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function startServer(opts: ServeOptions) {
  const file = resolve(opts.file);

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

  const clients = new Set<(data: string) => void>();
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
    const data = JSON.stringify(payload);
    for (const send of clients) send(data);
  };

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
  const SETTLE_MS = 50;
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

  // Showing a past round: the document and comments exactly as they were.
  // The document and its line anchors are frozen, so this is read-only.
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
  const watcher = watch(file, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const live = readLive();
      if (live === null) return;
      // Reset the count when the contents match the round again (a bare save, or an undo)
      changes = live === snapshot ? 0 : changes + 1;
      notifyChanged();
    }, 80);
  });

  const app = new Hono();

  const token = opts.token;

  /**
   * The secret to check against right now.
   *
   * Re-read rather than captured, so that rotating the stored token locks out the
   * cookies and scripts holding the old one without waiting for a restart. Cached for a
   * moment because this is on the path of every request, including each asset.
   *
   * A store that has become unreadable falls back to the startup value rather than
   * locking everyone out: losing the file should not end a review in progress.
   */
  let secretAt = 0;
  let secret = token;
  const currentSecret = (): string | null => {
    if (token === null || opts.tokenPinned) return token;
    const now = Date.now();
    if (now - secretAt >= 1_000) {
      secretAt = now;
      secret = readToken() ?? token;
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
      // Relative on purpose. Redirecting to the URL we were given would echo an
      // attacker-chosen host back at the browser as a location it should follow.
      return c.redirect(`${url.pathname}${url.search}`, 302);
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
     * The screen this came from is showing a round that has since been cut, so its line
     * numbers describe a document the server no longer has. Answered apart from the
     * range check because the two mean opposite things to whoever is reading: one says
     * the line is blank, the other says the document moved and the same comment will go
     * through once it is reloaded (#100). Same status the browser needs to tell them
     * apart without reading the text.
     */
    if (round !== undefined && round !== review.currentRound) {
      return c.text('the round moved; reload the document and send it again', 409);
    }
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
      endLine > doc.lineCount ||
      !doc.blocks.some((b) => b.startLine <= endLine && b.endLine >= startLine)
    ) {
      return c.text('line range does not point at any text', 400);
    }
    const comment = makeComment(snapshot, startLine, endLine, body, opts.author);
    // Written before it is shown. Pushing first would leave a comment that only exists
    // in memory when the write fails: the POST reports failure, GET returns it anyway,
    // and the next successful save persists the one that was refused.
    const next = [...comments, comment];
    saveComments(file, review.currentRound, next);
    comments = next;
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
   * `authorKind` is stamped here rather than taken from the request. Without
   * authentication (#10) a client saying "I am the agent" means nothing, and #12 turns
   * that distinction into whether the conversation can be read at all.
   */
  app.post('/api/comments/:id/replies', vValidator('json', CreateReplySchema), (c) => {
    const added = addReply(file, c.req.param('id'), c.req.valid('json').body, opts.author, 'human');
    if (!added) return c.text('not found', 404);
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
   * The second one is refused rather than queued. Queuing it just opens that spare round
   * a moment later; refusing says the truth, which is that the round it asked for exists
   * already. It arrives on that screen as the `round` event, same as any other.
   */
  let cutting = false;

  // Only a person cuts a round. An agent's intermediate save never does.
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
      round: review.currentRound,
      // Across every round, matching `akapen comments`: closing a round hands the
      // unresolved ones over, so they are still what the document is waiting on.
      unresolved: pendingComments(file).length,
    };
    return c.json(status);
  });

  /**
   * The other akapen running for this user, built here rather than in the browser.
   *
   * The browser cannot do it. Every instance is a different origin, so it would need
   * CORS on an endpoint that has none, and one bound to `127.0.0.1` is not reachable
   * from the reader's machine at all while being perfectly reachable from here.
   */
  app.get('/api/instances', async (c) => {
    const live = await liveInstances({ excludePid: process.pid, token: currentSecret() });
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

  app.get('/events', () => {
    let send!: (data: string) => void;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        send = (data: string) => {
          try {
            controller.enqueue(enc.encode(`data: ${data}\n\n`));
          } catch {
            clients.delete(send);
          }
        };
        clients.add(send);
        // The first render comes from /api/doc on load. Sending a doc here would
        // rebuild the screen on every reconnect.
        send(JSON.stringify(changedEvent()));
      },
      cancel() {
        clients.delete(send);
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

  // Only what ASSETS names is served. No directory walking means there is no path
  // traversal to begin with, and it works unchanged inside the single binary.
  app.get('*', (c) => {
    const path = new URL(c.req.url).pathname;
    const name = path === '/' ? 'index.html' : path.slice(1);
    const asset = ASSETS[name];
    if (!asset) return c.text('not found', 404);
    return c.body(Bun.file(asset).stream(), 200, { 'content-type': mimeFor(name) });
  });

  // One process, as before. Hono only replaces the routing inside the same fetch
  // handler; there is no second server and nothing to proxy.
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch: app.fetch,
  });

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
    });
  }

  /**
   * Shut everything this started, not just the socket.
   *
   * The CLI never needs it — the process exits and takes the watcher with it. Anything
   * that starts a server and keeps running does need it: `server.stop()` alone leaves
   * the FSWatcher and a pending debounce timer holding the event loop open.
   */
  const stop = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    watcher.close();
    // Before the socket closes: an entry left pointing at a port nobody is listening on
    // is what every reader then has to spend a timeout discovering.
    removeInstance();
    await server.stop(true);
  };

  return { server, stop, storeDir: storeDir(file), round: review.currentRound };
}
