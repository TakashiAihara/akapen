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
  // 画面に出すのは live のファイルではなく現ラウンドのスナップショット。
  // コメントが紐づく相手を凍結することで、書いている最中に位置が競合する経路を構造から消す。
  let snapshot = roundContent(file, review.currentRound);
  let comments: Comment[] = loadComments(file, review.currentRound);
  let changes = 0;

  const clients = new Set<(data: string) => void>();
  /**
   * SSE は通知の経路であって描画の経路ではない。流すのは「本文が変わりました」だけ。
   * doc payload を送り付けると、受け取った側は画面を作り直すことになり、
   * 読んでいる位置・入力中のフォーカス・IME の変換・本文の選択が人の操作と無関係に壊れる。
   * 画面を変えるかどうかは人が決める、というラウンド制の原則を画面全体に通す。
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
      // 現ラウンドより前の未解決コメント。持ち越さない代わりに「消えていない」ことを示す
      carried: carriedOver(file),
      changed: changedState(),
    });

  // 過去ラウンドの表示。当時の本文と当時のコメントをそのまま返す。
  // 本文と行アンカーは凍結済みなので読み取り専用。
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
        // 応答だけ返す。打った本人の画面は手元で更新する
        return Response.json({ comment: c, comments, carried: carriedOver(file) });
      }

      // resolve は過去ラウンドのコメントにも効かせる。ステータスまで凍らせると
      // 未解決コメントを閉じる手段が無くなり、エージェントへの受け渡しが詰まる。
      const resolveMatch = /^\/api\/comments\/([^/]+)\/resolve$/.exec(path);
      if (resolveMatch && req.method === 'POST') {
        const updated = updateComment(file, resolveMatch[1]!, (c) => {
          c.resolved = !c.resolved;
        });
        if (!updated) return new Response('not found', { status: 404 });
        if (updated.round === review.currentRound) comments = loadComments(file, review.currentRound);
        return Response.json({ comment: updated, comments, carried: carriedOver(file) });
      }

      // ラウンドを切るのは人。エージェントの途中保存では刻まない。
      if (path === '/api/rounds' && req.method === 'POST') {
        const live = readLive();
        if (live === null) return new Response('cannot read file', { status: 500 });
        review = openRound(file, live);
        snapshot = live;
        comments = [];
        changes = 0;
        // ラウンドが変わると本文も変わる。新しい本文ごと返し、押した本人の画面だけ差し替える
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
            // 初回表示は読み込み時の /api/doc が担う。ここで doc を送ると
            // 再接続のたびに画面が作り直される
            send(JSON.stringify({ type: 'changed', ...changedState() }));
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

      // キーマップの上書き。CSS と同じく、設定で変えられる口を最初から開けておく。
      // 壊れた JSON で操作不能にならないよう、読めなければ既定のまま動かす。
      if (path === '/keymap.json') {
        let body = '{}';
        if (opts.keymapPath && existsSync(opts.keymapPath)) {
          const raw = readFileSync(opts.keymapPath, 'utf8');
          try {
            JSON.parse(raw);
            body = raw;
          } catch {
            console.error(`akapen: keymap の JSON が壊れています。既定のキーマップで続行します: ${opts.keymapPath}`);
          }
        }
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      }

      // 配信するのは ASSETS に名指しした分だけ。ディレクトリを辿らないので
      // パストラバーサルの経路が最初から無く、単一バイナリでもそのまま動く。
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
