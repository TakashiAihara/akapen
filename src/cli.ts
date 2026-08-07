#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from './server.ts';
import { load, reanchor } from './store.ts';

const USAGE = `akapen — markdown inline review (PoC)

  akapen <file.md> [options]     レビュー用のサーバを立てる
  akapen comments <file.md>      未解決コメントを JSON で出す (エージェント向け)

options:
  --host <addr>    リッスンアドレス (default 127.0.0.1)
  -p, --port <n>   ポート (default 4300)
  --css <file>     追加で読み込む CSS
  --author <name>  コメントの著者名 (default $USER)
  --all            comments: 解決済みも含める
`;

type Args = { _: string[]; [k: string]: string | boolean | string[] };

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
  const store = load(file);
  const comments = reanchor(store.comments, readFileSync(file, 'utf8')).filter((c) => args.all || !c.resolved);
  console.log(
    JSON.stringify(
      comments.map((c) => ({
        id: c.id,
        path: resolve(file),
        start_line: c.startLine,
        end_line: c.endLine,
        body: c.body,
        anchor: c.anchor,
        drifted: c.drifted,
        author: c.author,
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
const { server, storeDir } = startServer({
  file,
  host,
  port,
  author: (args.author as string) ?? process.env.USER ?? 'user',
  cssPath: args.css ? resolve(args.css as string) : undefined,
});

console.log(`akapen  ${resolve(file)}`);
console.log(`  url     http://${host}:${server.port}`);
console.log(`  store   ${storeDir}`);
if (host !== '127.0.0.1') console.log(`  note    認証はありません。到達できる範囲に注意してください。`);
