/**
 * An import with `with { type: 'file' }` evaluates to a path the file can be read
 * from (`/$bunfs/...` inside the single binary). TypeScript does not look at import
 * attributes, so it falls back to per-extension defaults (css unknown, js any,
 * html HTMLBundle). Pin them to string here.
 */
declare module '*.css' {
  const path: string;
  export default path;
}

declare module '*.min.js' {
  const path: string;
  export default path;
}

// @akapen/web/dist is browser build output. We embed the path only and never look inside.
declare module '@akapen/web/dist/app.js' {
  const path: string;
  export default path;
}

declare module '@akapen/web/dist/mermaid.js' {
  const path: string;
  export default path;
}

declare module '@akapen/web/dist/graphviz.js' {
  const path: string;
  export default path;
}

declare module '@akapen/web/style.css' {
  const path: string;
  export default path;
}
