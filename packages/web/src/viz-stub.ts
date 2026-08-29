/**
 * Stands in for `@viz-js/viz` in the DBML entry.
 *
 * The DBML renderer requires that package at module scope, but only reaches it to turn
 * DOT into SVG — and this entry asks it only for DOT, because the graphviz akapen
 * already ships (`graphviz.js`) is the one that should draw the picture. Left alone,
 * the import pulls a second copy of graphviz into the bundle: 1.37MB rather than 97KB,
 * for an engine that would never be called.
 *
 * Throwing rather than returning something inert. If a future version of that package
 * starts reaching for the engine on the DOT path, the failure should say what happened
 * instead of producing a figure that is quietly missing whatever the engine was for.
 */
export function instance(): never {
  throw new Error('this bundle produces DOT only; graphviz lives in graphviz.js');
}

export default { instance };
