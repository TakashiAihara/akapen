/**
 * DBML in, DOT out. Its own entry, for the reason mermaid and graphviz have one.
 *
 * Only the parser and the DOT serialiser are here. The layout is graphviz's, and that
 * is already bundled once — see `viz-stub.ts` for how the second copy is kept out.
 */
import { check } from '@egomobile/dbml-renderer/lib/checker';
import { parse } from '@egomobile/dbml-renderer/lib/parser';
import { render } from '@egomobile/dbml-renderer/lib/renderer';

/** Throws with the renderer's own message, which names the line. */
export default async function dbmlToDot(source: string): Promise<string> {
  return render(check(parse(source)), 'dot');
}
