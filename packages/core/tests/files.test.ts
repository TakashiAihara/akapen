/**
 * Which images beside a document may be read (#81).
 *
 * Every refusal test is paired with an acceptance on the same layout. A resolver that
 * refused everything would pass the refusals alone, and a document with broken images
 * is the state this exists to end.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documentFileSrc, imageMime, isInside, resolveDocumentFile } from '../src/files.ts';

describe('which image srcs point at the file route', () => {
  it('takes a document-relative path, decoded back to what was typed', () => {
    expect(documentFileSrc('png/overview.png')).toBe('/file?path=png%2Foverview.png');
    expect(documentFileSrc('../images/a%20b.png')).toBe('/file?path=..%2Fimages%2Fa%20b.png');
  });

  it('drops a query and a fragment, which a file does not have', () => {
    expect(documentFileSrc('a.png?v=2#x')).toBe('/file?path=a.png');
  });

  it('leaves everything that does not name something beside the document as written', () => {
    for (const src of [
      'https://example.com/a.png',
      'data:image/png;base64,AAAA',
      '//cdn/a.png',
      '/abs/a.png',
      '#a',
      '?x=1',
      '',
    ]) {
      expect(documentFileSrc(src)).toBeNull();
    }
  });
});

describe('resolving a requested image', () => {
  let root: string;
  let doc: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'akapen-files-'));
    mkdirSync(join(root, 'notes', 'png'), { recursive: true });
    mkdirSync(join(root, 'images'));
    doc = join(root, 'notes', 'doc.md');
    writeFileSync(doc, '# doc');
    writeFileSync(join(root, 'notes', 'png', 'a.png'), 'png');
    writeFileSync(join(root, 'notes', '..b.png'), 'png');
    writeFileSync(join(root, 'images', 'c.png'), 'png');
    writeFileSync(join(root, 'notes', '.env'), 'SECRET=1');
    writeFileSync(join(root, 'outside.png'), 'png');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const notes = () => join(root, 'notes');

  it('reads an image below the document', () => {
    expect(resolveDocumentFile(doc, notes(), 'png/a.png')).toBe(join(notes(), 'png', 'a.png'));
  });

  it('reads a file whose name merely starts with two dots', () => {
    expect(resolveDocumentFile(doc, notes(), '..b.png')).toBe(join(notes(), '..b.png'));
  });

  it('refuses a path that leaves the root, and reads the same path once the root is wider', () => {
    expect(resolveDocumentFile(doc, notes(), '../images/c.png')).toBeNull();
    expect(resolveDocumentFile(doc, root, '../images/c.png')).toBe(join(root, 'images', 'c.png'));
  });

  it('refuses a traversal however deep it goes', () => {
    expect(resolveDocumentFile(doc, notes(), `${'../'.repeat(12)}${root.slice(1)}/outside.png`)).toBeNull();
    expect(resolveDocumentFile(doc, notes(), '../outside.png')).toBeNull();
  });

  it('refuses an absolute path even inside the root', () => {
    expect(resolveDocumentFile(doc, notes(), join(notes(), 'png', 'a.png'))).toBeNull();
  });

  it('refuses a file that is not on the allowlist', () => {
    expect(resolveDocumentFile(doc, notes(), '.env')).toBeNull();
    expect(resolveDocumentFile(doc, notes(), 'doc.md')).toBeNull();
  });

  it('refuses a symlink that walks out of the root with no .. in its name', () => {
    symlinkSync(join(root, 'outside.png'), join(notes(), 'link.png'));
    expect(resolveDocumentFile(doc, notes(), 'link.png')).toBeNull();
  });

  it('refuses a symlink with an image name that points at something that is not one', () => {
    symlinkSync(join(notes(), '.env'), join(notes(), 'env.png'));
    expect(resolveDocumentFile(doc, notes(), 'env.png')).toBeNull();
  });

  it('follows a symlink that stays inside the root', () => {
    symlinkSync(join(notes(), 'png', 'a.png'), join(notes(), 'alias.png'));
    expect(resolveDocumentFile(doc, notes(), 'alias.png')).toBe(join(notes(), 'png', 'a.png'));
  });

  it('works when the root itself is reached through a symlink', () => {
    const linked = join(root, 'linked-notes');
    symlinkSync(notes(), linked);
    expect(resolveDocumentFile(join(linked, 'doc.md'), linked, 'png/a.png')).toBe(
      join(notes(), 'png', 'a.png'),
    );
  });

  it('refuses a directory and a file that is not there', () => {
    mkdirSync(join(notes(), 'dir.png'));
    expect(resolveDocumentFile(doc, notes(), 'dir.png')).toBeNull();
    expect(resolveDocumentFile(doc, notes(), 'missing.png')).toBeNull();
  });

  it('matches the extension without regard to case', () => {
    writeFileSync(join(notes(), 'UP.PNG'), 'png');
    expect(resolveDocumentFile(doc, notes(), 'UP.PNG')).toBe(join(notes(), 'UP.PNG'));
    expect(imageMime('UP.PNG')).toBe('image/png');
  });
});

describe('whether a path is inside a root', () => {
  it('reads below as inside and beside as outside, whatever the name starts with', () => {
    expect(isInside('/a/b', '/a/b/c.png')).toBe(true);
    expect(isInside('/a/b', '/a/c.png')).toBe(false);
    expect(isInside('/a/b', '/a/b/..c.png')).toBe(true);
  });
});
