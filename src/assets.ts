/**
 * 配信する静的ファイルの一覧。
 *
 * app.js と mermaid.js は `bun run build:web` の成果物 (web/dist)。
 * ブラウザ側も TypeScript なので、素の web/*.ts を配信することはできない。
 *
 * `with { type: 'file' }` で読むと、`bun build --compile` の時にファイルの中身が
 * バイナリへ埋め込まれ、import の値が実行時のパス (バイナリ内なら `/$bunfs/...`) になる。
 * 開発時 (`bun run src/cli.ts`) は実ファイルのパスがそのまま入るので、両方で同じコードが動く。
 *
 * ディレクトリを走査せず 1 つずつ名指しするのは、埋め込みが静的解析でしか効かないため。
 * web/ にファイルを足したらここにも足す。
 */
import indexHtml from '../web/index.html' with { type: 'file' };
import styleCss from '../web/style.css' with { type: 'file' };
import appJs from '../web/dist/app.js' with { type: 'file' };
import mermaidJs from '../web/dist/mermaid.js' with { type: 'file' };

/** URL パス → 実行時に読めるパス */
export const ASSETS: Record<string, string> = {
  // bun の型は import attributes を見ておらず .html を HTMLBundle として扱う。
  // 実行時は埋め込み先のパス (string) なので、ここだけ合わせる。
  'index.html': indexHtml as unknown as string,
  'style.css': styleCss,
  'app.js': appJs,
  'mermaid.js': mermaidJs,
};

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function mimeFor(name: string): string {
  return MIME[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream';
}
