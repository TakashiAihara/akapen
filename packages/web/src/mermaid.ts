/**
 * mermaid gets its own entry.
 *
 * Bundling it into app makes that 3.3MB, parsed on every load even for documents with
 * no diagram at all. But bun's --splitting emits a hundred-odd hash-named chunks, which
 * does not fit src/assets.ts naming each file it embeds.
 *
 * Two entries keep the output at two known files while still loading it only on demand.
 */
export { default } from 'mermaid';
