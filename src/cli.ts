#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './server.ts';
import { loadReview, pendingComments } from './store.ts';

const USAGE = `akapen — markdown inline review (PoC)

  akapen <file.md> [options]     レビュー用のサーバを立てる
  akapen comments <file.md>      未解決コメントを JSON で出す (エージェント向け)

options:
  --host <addr>    リッスンアドレス (default 127.0.0.1)
  -p, --port <n>   ポート (default 4300)
  --css <file>     追加で読み込む CSS
  --keymap <file>  キーマップを上書きする JSON ({ "動作名": ["キー"] })
  --author <name>  コメントの著者名 (default $USER)
  --all            comments: 解決済みも含める
`;

/**
 * 受け付けるフラグを名前で持つ。
 *
 * index signature だけにすると `args.port` が noPropertyAccessFromIndexSignature に
 * 引っかかり、全部 bracket 記法になって読めなくなる。既知のフラグを並べておけば
 * dot で書けるうえに、何を受け付けるかが型に出る。
 */
type Args = {
  _: string[];
  help?: string | boolean;
  host?: string | boolean;
  port?: string | boolean;
  css?: string | boolean;
  keymap?: string | boolean;
  author?: string | boolean;
  all?: string | boolean;
  [k: string]: string | boolean | string[] | undefined;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-p') args.port = argv[++i]!;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k!] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) args[k!] = argv[++i]!;
      else args[k!] = true;
    } else (args._ as string[]).push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const positional = args._ as string[];

if (positional.length === 0 || args.help) {
  console.log(USAGE);
  process.exit(0);
}

if (positional[0] === 'comments') {
  const file = positional[1];
  if (!file || !existsSync(file)) {
    console.error(`akapen: no such file: ${file ?? '(missing)'}`);
    process.exit(1);
  }
  // 未解決なら過去ラウンド分も出す。締めた時点で画面からは消えるが、指摘は消えていない。
  // 行番号はそのラウンドのスナップショット内でのもので live のファイルとは一致しないので、
  // エージェントは anchor (当時の原文) で現在のファイルを照合する。
  const review = loadReview(file);
  const comments = pendingComments(file, Boolean(args.all));
  console.log(
    JSON.stringify(
      comments.map((c) => ({
        id: c.id,
        path: resolve(file),
        round: c.round,
        // 現ラウンドのものかどうか。過去のものは「当時の本文に対する指摘」で、
        // いまのファイルでは行がズレている前提で扱う必要がある
        current_round: c.round === review.currentRound,
        start_line: c.startLine,
        end_line: c.endLine,
        body: c.body,
        anchor: c.anchor,
        author: c.author,
        resolved: c.resolved,
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}

const file = positional[0]!;
if (!existsSync(file)) {
  console.error(`akapen: no such file: ${file}`);
  process.exit(1);
}

const host = (args.host as string) ?? '127.0.0.1';
const port = Number(args.port ?? 4300);
const { server, storeDir, round } = startServer({
  file,
  host,
  port,
  author: (args.author as string) ?? process.env['USER'] ?? 'user',
  // exactOptionalPropertyTypes: `?:` は「省略できる」であって「undefined を渡せる」ではない。
  // 指定が無いなら鍵ごと落とす
  ...(args.css ? { cssPath: resolve(args.css as string) } : {}),
  ...(args.keymap ? { keymapPath: resolve(args.keymap as string) } : {}),
});

console.log(`akapen  ${resolve(file)}`);
console.log(`  url     http://${host}:${server.port}`);
console.log(`  round   ${String(round).padStart(3, '0')}`);
console.log(`  store   ${storeDir}`);
if (host !== '127.0.0.1') console.log(`  note    認証はありません。到達できる範囲に注意してください。`);
