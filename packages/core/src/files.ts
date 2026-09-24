/**
 * Images that sit beside the document (#81).
 *
 * This gives up what the static assets had for free — "only what ASSETS names is
 * served" — so containment is built here rather than inherited. docs/design/document-images.md
 * has the decisions behind each rule.
 */
import { realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * An allowlist, never a blocklist: a server that hands out `.env` because nobody
 * thought to list it is the failure this is here to prevent.
 */
export const IMAGE_MIME: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
  }),
);

/** Where the renderer points a relative image. The server answers it. */
export const FILE_ROUTE = '/file';

/**
 * The src to render for an image, or null to leave it as written.
 *
 * Only a document-relative path is taken. A scheme (`https:`, `data:`), a
 * protocol-relative `//host`, an absolute `/path` and a bare fragment all stay as the
 * writer put them: none of them names something beside the document.
 *
 * markdown-it has already percent-encoded the src, so it is decoded back to the path
 * the writer typed; the query and fragment are dropped because a file has neither.
 */
export function documentFileSrc(src: string): string | null {
  if (src === '' || src.startsWith('/') || src.startsWith('#') || src.startsWith('?')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;

  const bare = src.replace(/[?#].*$/, '');
  if (bare === '') return null;
  let path: string;
  try {
    path = decodeURIComponent(bare);
  } catch {
    path = bare;
  }
  return `${FILE_ROUTE}?path=${encodeURIComponent(path)}`;
}

/**
 * The file a request names, or null for every kind of refusal.
 *
 * Refusals are not told apart. Answering "exists but outside" differently from "does
 * not exist" would let whoever holds the page probe the file system for what is there.
 *
 * Containment is decided on real paths, on both sides. Looking at the request for `..`
 * decides nothing: a symlink inside the root walks out with no `..` in sight, and a
 * root that is itself a symlink would refuse everything if only one side were resolved.
 */
export function resolveDocumentFile(docFile: string, root: string, requested: string): string | null {
  if (requested === '' || requested.includes('\0') || isAbsolute(requested)) return null;

  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(resolve(dirname(docFile), requested));
    realRoot = realpathSync(root);
  } catch {
    return null;
  }

  const rel = relative(realRoot, real);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  // Checked on the real name, the one that gets read: a symlink named `a.png` pointing
  // at `.env` inside the root must not get through.
  if (!(extname(real).toLowerCase() in IMAGE_MIME)) return null;

  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

export function imageMime(path: string): string {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
