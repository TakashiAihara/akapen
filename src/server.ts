import { readFileSync, watch, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSETS, mimeFor } from './assets.ts';
import { buildDoc } from './blocks.ts';
import {
  carriedOver,
  ensureRound,
  loadComments,
  makeComment,
  openRound,
  roundContent,
  saveComments,
  storeDir,
  updateComment,
  type Comment,
  type Review,
} from './store.ts';

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

  let review: Review = ensureRound(file, readFileSync(file, 'utf8'));
  // What we render is the current round's snapshot, not the live file. Freezing what
  // comments attach to removes, structurally, the path where positions conflict while
  // someone is still writing.
  let snapshot = roundContent(file, review.currentRound);
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
  const notifyChanged = () => {
    const payload = JSON.stringify({ type: 'changed', ...changedState() });
    for (const send of clients) send(payload);
  };

  const readLive = (): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };

  const changedState = () => {
    const live = readLive();
    return { changes, dirty: live !== null && live !== snapshot };
  };

  const roundState = () => ({
    n: review.currentRound,
    total: review.rounds.length,
    createdAt: review.rounds.find((r) => r.n === review.currentRound)?.createdAt ?? null,
    all: review.rounds.map((r) => ({ n: r.n, createdAt: r.createdAt, closedAt: r.closedAt })),
  });

  const docPayload = () =>
    JSON.stringify({
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
  const historyPayload = (n: number) =>
    JSON.stringify({
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
  watch(file, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const live = readLive();
      if (live === null) return;
      // Reset the count when the contents match the round again (a bare save, or an undo)
      changes = live === snapshot ? 0 : changes + 1;
      notifyChanged();
    }, 80);
  });

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === '/api/doc') {
        const want = Number(url.searchParams.get('round') ?? review.currentRound);
        if (want !== review.currentRound) {
          if (!review.rounds.some((r) => r.n === want)) return new Response('no such round', { status: 404 });
          return new Response(historyPayload(want), { headers: { 'content-type': 'application/json' } });
        }
        return new Response(docPayload(), { headers: { 'content-type': 'application/json' } });
      }

      if (path === '/api/comments' && req.method === 'GET') {
        return Response.json(comments);
      }

      if (path === '/api/comments' && req.method === 'POST') {
        const b = (await req.json()) as { startLine: number; endLine: number; body: string };
        const c = makeComment(snapshot, b.startLine, b.endLine, b.body, opts.author);
        comments.push(c);
        saveComments(file, review.currentRound, comments);
        // Just answer. The author's own screen updates locally.
        return Response.json({ comment: c, comments, carried: carriedOver(file) });
      }

      // resolve works on past rounds too. Freezing the status as well would leave no
      // way to close an unresolved comment, and the agent handoff would jam.
      const resolveMatch = /^\/api\/comments\/([^/]+)\/resolve$/.exec(path);
      if (resolveMatch && req.method === 'POST') {
        const updated = updateComment(file, resolveMatch[1]!, (c) => {
          c.resolved = !c.resolved;
        });
        if (!updated) return new Response('not found', { status: 404 });
        if (updated.round === review.currentRound) comments = loadComments(file, review.currentRound);
        return Response.json({ comment: updated, comments, carried: carriedOver(file) });
      }

      // Only a person cuts a round. An agent's intermediate save never does.
      if (path === '/api/rounds' && req.method === 'POST') {
        const live = readLive();
        if (live === null) return new Response('cannot read file', { status: 500 });
        review = openRound(file, live);
        snapshot = live;
        comments = [];
        changes = 0;
        // A new round means a new document. Return it, and only the clicker's screen swaps.
        return new Response(docPayload(), { headers: { 'content-type': 'application/json' } });
      }

      if (path === '/api/rounds' && req.method === 'GET') {
        return Response.json({ current: review.currentRound, rounds: review.rounds });
      }

      if (path === '/events') {
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
            send(JSON.stringify({ type: 'changed', ...changedState() }));
          },
          cancel() {
            clients.delete(send);
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }

      // Extra CSS. crit had no such hook; open one from the start.
      if (path === '/custom.css') {
        const css = opts.cssPath && existsSync(opts.cssPath) ? readFileSync(opts.cssPath, 'utf8') : '';
        return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } });
      }

      // Keymap override. Like the CSS hook, a way to configure it from the start.
      // A broken JSON must not make the tool unusable, so fall back to the defaults.
      if (path === '/keymap.json') {
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
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      }

      // Only what ASSETS names is served. No directory walking means there is no path
      // traversal to begin with, and it works unchanged inside the single binary.
      const name = path === '/' ? 'index.html' : path.slice(1);
      const asset = ASSETS[name];
      if (asset) {
        return new Response(Bun.file(asset), { headers: { 'content-type': mimeFor(name) } });
      }

      return new Response('not found', { status: 404 });
    },
  });

  return { server, storeDir: storeDir(file), round: review.currentRound };
}
