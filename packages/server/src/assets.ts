/**
 * The static files we serve.
 *
 * app.js and the engine entries are build output (`bun run build:web` → web/dist). The
 * browser side is TypeScript too, so the raw web/*.ts cannot be served.
 *
 * Importing with `with { type: 'file' }` embeds the contents into the binary at
 * `bun build --compile` time, and the imported value becomes a path usable at
 * runtime (`/$bunfs/...` inside the binary). In development the value is the real
 * file path, so the same code works both ways.
 *
 * Each file is named individually rather than discovered by scanning, because
 * embedding only works through static analysis. Add a file to web/ and you must
 * add it here too.
 */
import indexHtml from '@akapen/web/index.html' with { type: 'file' };
import styleCss from '@akapen/web/style.css' with { type: 'file' };
import appJs from '@akapen/web/dist/app.js' with { type: 'file' };
import mermaidJs from '@akapen/web/dist/mermaid.js' with { type: 'file' };
import graphvizJs from '@akapen/web/dist/graphviz.js' with { type: 'file' };
import dbmlJs from '@akapen/web/dist/dbml.js' with { type: 'file' };

/**
 * URL path → a path readable at runtime.
 *
 * Null-prototype, because this is looked up with a name taken straight from the URL.
 * An object literal inherits from Object.prototype, so `/constructor` and `/toString`
 * would find a function, pass a truthy check and reach `Bun.file()` — a 500 where a
 * 404 belongs. Cutting the prototype removes the whole class rather than guarding the
 * one call site that exists today.
 */
export const ASSETS: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  // Bun's types ignore import attributes and treat .html as an HTMLBundle.
  // At runtime it is the embedded path (a string), so line the type up here.
  'index.html': indexHtml as unknown as string,
  'style.css': styleCss,
  'app.js': appJs,
  'mermaid.js': mermaidJs,
  'graphviz.js': graphvizJs,
  'dbml.js': dbmlJs,
});

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function mimeFor(name: string): string {
  return MIME[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream';
}
