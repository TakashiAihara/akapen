/**
 * The browser build.
 *
 * A script rather than a `bun build` line, because one dependency has to be replaced at
 * bundle time: the DBML renderer requires `@viz-js/viz` at module scope and only reaches
 * it for SVG, while this entry wants DOT alone. Resolving it to a stub keeps a second
 * copy of graphviz out of the binary — 97KB rather than 1.37MB for that entry.
 *
 * The engines are separate entries so a document with no figure in it fetches neither,
 * which is why they are listed as external here: the import that reaches them is written
 * as a path so the bundler leaves it alone.
 */
import { fileURLToPath } from 'node:url';

// `.pathname` would hand back `/C:/...` on Windows, which resolves as a path nowhere.
const stub = fileURLToPath(new URL('./src/viz-stub.ts', import.meta.url));

const built = await Bun.build({
  entrypoints: ['./src/app.ts', './src/mermaid.ts', './src/graphviz.ts', './src/dbml.ts'],
  target: 'browser',
  outdir: './dist',
  minify: true,
  external: ['/mermaid.js', '/graphviz.js', '/dbml.js'],
  plugins: [
    {
      name: 'viz-stub',
      setup(build) {
        build.onResolve({ filter: /^@viz-js\/viz$/ }, () => ({ path: stub }));
      },
    },
  ],
});

for (const log of built.logs) console.error(log);
if (!built.success) process.exit(1);

for (const out of built.outputs) {
  const kb = (await out.arrayBuffer()).byteLength / 1024;
  console.log(
    `  ${out.path.split('/').pop()}  ${kb >= 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(2)} KB`}`,
  );
}
