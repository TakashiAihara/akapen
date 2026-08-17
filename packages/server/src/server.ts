import { readFileSync, watch, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { vValidator } from '@hono/valibot-validator';
import { ASSETS, mimeFor } from './assets.ts';
import { buildDoc } from '@akapen/core/blocks';
import {
  addReply,
  carriedOver,
  editComment,
  ensureRound,
  isVisible,
  loadComments,
  makeComment,
  openRound,
  roundContent,
  saveComments,
  setCommentDeleted,
  storeDir,
  updateComment,
  type Comment,
  type Review,
} from '@akapen/core/store';
import {
  CreateCommentSchema,
  CreateReplySchema,
  DocQuerySchema,
  EditCommentSchema,
  type ChangedEvent,
  type ChangedState,
  type DocPayload,
  type RoundState,
} from '@akapen/shared';

export type ServeOptions = {
  file: string;
  host: string;
  port: number;
  author: string;
  cssPath?: string;
  keymapPath?: string;
};

export function startServer(opts: ServeOptions) {
  const file = resolve(opts.file);

  /**
   * A round's comments as anyone should see them.
   *
   * Withdrawn ones are still in comments.json — deletion is logical — so the skipping
   * happens here rather than in the storage read, which `updateComment` writes back
   * through. History gets the same treatment: a comment withdrawn later is withdrawn
   * in the round it was written in too.
   */
  const visibleComments = (n: number): Comment[] => loadComments(file, n).filter(isVisible);

  let review: Review = ensureRound(file, readFileSync(file, 'utf8'));
  // What we render is the current round's snapshot, not the live file. Freezing what
  // comments attach to removes, structurally, the path where positions conflict while
  // someone is still writing.
  let snapshot = roundContent(file, review.currentRound);
  let comments: Comment[] = visibleComments(review.currentRound);
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
  const notifyChanged = () => {
    const payload = JSON.stringify(changedEvent());
    for (const send of clients) send(payload);
  };

  const readLive = (): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };

  const changedState = (): ChangedState => {
    const live = readLive();
    return { changes, dirty: live !== null && live !== snapshot };
  };

  const changedEvent = (): ChangedEvent => ({ type: 'changed', ...changedState() });

  const roundState = (): RoundState => ({
    n: review.currentRound,
    total: review.rounds.length,
    createdAt: review.rounds.find((r) => r.n === review.currentRound)?.createdAt ?? null,
    all: review.rounds.map((r) => ({ n: r.n, createdAt: r.createdAt, closedAt: r.closedAt })),
  });

  const docPayload = (): DocPayload => ({
    type: 'doc',
    doc: buildDoc(file, snapshot),
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
    comments: visibleComments(n),
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

  app.get('/api/doc', vValidator('query', DocQuerySchema), (c) => {
    const want = c.req.valid('query').round ?? review.currentRound;
    if (want === review.currentRound) return c.json(docPayload());
    if (!review.rounds.some((r) => r.n === want)) return c.text('no such round', 404);
    return c.json(historyPayload(want));
  });

  app.get('/api/comments', (c) => c.json(comments));

  app.post('/api/comments', vValidator('json', CreateCommentSchema), (c) => {
    const { startLine, endLine, body } = c.req.valid('json');
    // The schema only knows a line number is a positive integer. What the range points
    // at depends on the snapshot, which the schema cannot see. The test is not "within
    // the line count" — a trailing newline makes a last line that is not there, and a
    // blank line is not addressable either. Both would store an anchor that is empty or
    // whitespace, and an anchor that matches nothing is feedback nobody can find again.
    const lines = snapshot.split('\n');
    const selected = lines.slice(startLine - 1, endLine);
    if (endLine < startLine || endLine > lines.length || !selected.some((l) => l.trim() !== '')) {
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
    if (updated.round === review.currentRound) comments = visibleComments(review.currentRound);
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
    if (added.comment.round === review.currentRound) comments = visibleComments(review.currentRound);
    return c.json({ comment: added.comment, comments, carried: carriedOver(file) });
  });

  /**
   * Change the body. Not the range, not the anchor — those say which text this is
   * about, and moving them would rewrite what the comment had always claimed.
   *
   * Allowed on a closed round, like resolve and replies. The wording of a remark is on
   * the conversation side of what a round freezes.
   */
  app.patch('/api/comments/:id', vValidator('json', EditCommentSchema), (c) => {
    const updated = editComment(file, c.req.param('id'), c.req.valid('json').body);
    if (!updated) return c.text('not found', 404);
    if (updated.round === review.currentRound) comments = visibleComments(review.currentRound);
    return c.json({ comment: updated, comments, carried: carriedOver(file) });
  });

  /**
   * Withdraw a comment, on any round, and put it back with POST.
   *
   * Logical: the row stays in comments.json and only the places that show or hand over
   * comments skip it. A comment can be withdrawn after its round closed, by which point
   * it may already have reached an agent and been acted on — removing the row would
   * leave that work unexplained. It also makes undo free, so the UI does not hold one.
   *
   * Not the same as resolving. Resolved says the point was dealt with; a typo was not.
   */
  app.delete('/api/comments/:id', (c) => {
    const updated = setCommentDeleted(file, c.req.param('id'), true);
    if (!updated) return c.text('not found', 404);
    if (updated.round === review.currentRound) comments = visibleComments(review.currentRound);
    return c.json({ comment: updated, comments, carried: carriedOver(file) });
  });

  app.post('/api/comments/:id/restore', (c) => {
    const updated = setCommentDeleted(file, c.req.param('id'), false);
    if (!updated) return c.text('not found', 404);
    if (updated.round === review.currentRound) comments = visibleComments(review.currentRound);
    return c.json({ comment: updated, comments, carried: carriedOver(file) });
  });

  // Only a person cuts a round. An agent's intermediate save never does.
  app.post('/api/rounds', (c) => {
    const live = readLive();
    if (live === null) return c.text('cannot read file', 500);
    review = openRound(file, live);
    snapshot = live;
    comments = [];
    changes = 0;
    // A new round means a new document. Return it, and only the clicker's screen swaps.
    return c.json(docPayload());
  });

  app.get('/api/rounds', (c) => c.json({ current: review.currentRound, rounds: review.rounds }));

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
    await server.stop(true);
  };

  return { server, stop, storeDir: storeDir(file), round: review.currentRound };
}
