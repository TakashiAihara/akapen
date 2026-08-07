import { readFileSync, watch, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDoc } from './blocks.ts';
import { load, makeComment, reanchor, save, storeDir, type Store } from './store.ts';

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
  let store: Store = load(file);
  const clients = new Set<(data: string) => void>();

  const read = () => readFileSync(file, 'utf8');

  const docPayload = () => {
    const source = read();
    return JSON.stringify({
      type: 'doc',
      doc: buildDoc(file, source),
      comments: store.comments,
    });
  };

  // ファイル変更のたびに再アンカーする。行番号ではなく原文で貼り直すため、
  // エージェントが上に段落を足しても既存コメントは同じ文を指し続ける。
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(file, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const source = read();
      store = { ...store, comments: reanchor(store.comments, source) };
      save(store);
      const payload = docPayload();
      for (const send of clients) send(payload);
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
        return Response.json(store.comments);
      }

      if (path === '/api/comments' && req.method === 'POST') {
        const b = (await req.json()) as { startLine: number; endLine: number; body: string };
        const c = makeComment(read(), b.startLine, b.endLine, b.body, opts.author);
        store.comments.push(c);
        save(store);
        const payload = docPayload();
        for (const send of clients) send(payload);
        return Response.json(c);
      }

      const resolveMatch = /^\/api\/comments\/([^/]+)\/resolve$/.exec(path);
      if (resolveMatch && req.method === 'POST') {
        const c = store.comments.find((x) => x.id === resolveMatch[1]);
        if (!c) return new Response('not found', { status: 404 });
        c.resolved = !c.resolved;
        save(store);
        const payload = docPayload();
        for (const send of clients) send(payload);
        return Response.json(c);
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

  return { server, storeDir: storeDir(file) };
}
