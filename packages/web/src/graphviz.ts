/**
 * graphviz gets its own entry, for the reason mermaid has one: a document with no figure
 * in it must not parse an engine it will never call.
 *
 * The wasm is inlined by the bundler rather than fetched at load time, so this file is
 * the whole of it — nothing reaches the network, which is not negotiable for a tool that
 * is often looking at something private.
 */
import { Graphviz } from '@hpcc-js/wasm-graphviz';

let engine: Awaited<ReturnType<typeof Graphviz.load>> | null = null;

/** Lay out a DOT source and return SVG markup. Throws with graphviz's own message. */
export default async function renderDot(source: string): Promise<string> {
  engine ??= await Graphviz.load();
  return engine.dot(source);
}
