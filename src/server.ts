import { readFileSync, watch, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDoc } from './blocks.ts';
import {
  ensureRound,
  loadComments,
  makeComment,
  openRound,
  roundContent,
  saveComments,
  storeDir,
  type Comment,
  type Review,
} from './store.ts';

const WEB = join(import.meta.dir, '..', 'web');

export type ServeOptions = {
  file: string;
  host: string;
  port: number;
  author: string;
  cssPath?: string;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function startServer(opts: ServeOptions) {
  const file = resolve(opts.file);

  let review: Review = ensureRound(file, readFileSync(file, 'utf8'));
  // 画面に出すのは live のファイルではなく現ラウンドのスナップショット。
  // コメントが紐づく相手を凍結することで、書いている最中に位置が競合する経路を構造から消す。
  let snapshot = roundContent(file, review.currentRound);
  let comments: Comment[] = loadComments(file, review.currentRound);
  let changes = 0;

  const clients = new Set<(data: string) => void>();
  const broadcast = (payload: string) => {
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
  });

  const docPayload = () =>
    JSON.stringify({
      type: 'doc',
      doc: buildDoc(file, snapshot),
      comments,
      round: roundState(),
      changed: changedState(),
    });

  // live の変更で本文を差し替えない。「変わりました」を伝えるだけにして、
  // 次のラウンドへ進むかどうかの判断は人に残す。
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(file, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const live = readLive();
      if (live === null) return;
      // 内容が現ラウンドと同じに戻ったら数え直す (保存しただけ / 変更を戻した場合)
      changes = live === snapshot ? 0 : changes + 1;
      broadcast(JSON.stringify({ type: 'changed', ...changedState() }));
    }, 80);
  });

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === '/api/doc') {
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
        broadcast(docPayload());
        return Response.json(c);
      }

      const resolveMatch = /^\/api\/comments\/([^/]+)\/resolve$/.exec(path);
      if (resolveMatch && req.method === 'POST') {
        const c = comments.find((x) => x.id === resolveMatch[1]);
        if (!c) return new Response('not found', { status: 404 });
        c.resolved = !c.resolved;
        saveComments(file, review.currentRound, comments);
        broadcast(docPayload());
        return Response.json(c);
      }

      // ラウンドを切るのは人。エージェントの途中保存では刻まない。
      if (path === '/api/rounds' && req.method === 'POST') {
        const live = readLive();
        if (live === null) return new Response('cannot read file', { status: 500 });
        review = openRound(file, live);
        snapshot = live;
        comments = [];
        changes = 0;
        broadcast(docPayload());
        return Response.json(roundState());
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
            send(docPayload());
          },
          cancel() {
            clients.delete(send);
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
        });
      }

      // 拡張 CSS。crit に無かった口を最初から開けておく。
      if (path === '/custom.css') {
        const css = opts.cssPath && existsSync(opts.cssPath) ? readFileSync(opts.cssPath, 'utf8') : '';
        return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } });
      }

      if (path === '/vendor/mermaid.min.js') {
        const p = join(import.meta.dir, '..', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
        return new Response(Bun.file(p), { headers: { 'content-type': MIME['.js']! } });
      }

      const name = path === '/' ? 'index.html' : path.slice(1);
      const asset = join(WEB, name);
      if (asset.startsWith(WEB) && existsSync(asset)) {
        const ext = name.slice(name.lastIndexOf('.'));
        return new Response(Bun.file(asset), { headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' } });
      }

      return new Response('not found', { status: 404 });
    },
  });

  return { server, storeDir: storeDir(file), round: review.currentRound };
}
