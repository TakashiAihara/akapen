/**
 * What the browser tab is called.
 *
 * The documents are built with the real parser rather than hand-written blocks. The
 * derivation reads rendered HTML and undoes the entities markdown-it emits, so a
 * fixture written by hand would be checking my idea of that output instead of the
 * output — and would keep passing after the renderer stopped agreeing with it.
 */
import { buildDoc } from '@akapen/core/blocks';
import { describe, expect, it } from 'vitest';
import { documentTitle, isDocumentHeading } from '@akapen/shared/title';
import { pageTitle } from '../src/title.ts';

const doc = (source: string, path = '/home/x/notes/20-auth.md') => buildDoc(path, source);

describe('pageTitle', () => {
  it('names the tab after the first heading', () => {
    expect(pageTitle(doc('# The rail\n\nA paragraph.\n'))).toBe('The rail — akapen');
  });

  it('drops inline markup, so the tab shows what the heading reads as', () => {
    expect(pageTitle(doc('# `token` and the **rail**\n'))).toBe('token and the rail — akapen');
  });

  it('restores characters the renderer escaped', () => {
    expect(pageTitle(doc('# a & b < c\n'))).toBe('a & b < c — akapen');
  });

  it('leaves an ampersand written in the document as an ampersand', () => {
    expect(pageTitle(doc('# a &amp;lt; b\n'))).toBe('a &lt; b — akapen');
  });

  it('takes the first of several headings', () => {
    expect(pageTitle(doc('# First\n\n# Second\n'))).toBe('First — akapen');
  });

  it('reads a heading written under its text', () => {
    expect(pageTitle(doc('The rail\n========\n'))).toBe('The rail — akapen');
  });

  it('folds a heading that runs over two lines onto one, because a tab is one line', () => {
    expect(pageTitle(doc('The rail\nand the doc\n===========\n'))).toBe('The rail and the doc — akapen');
  });

  it('reads past the frontmatter to the heading below it', () => {
    expect(pageTitle(doc('---\ntitle: t\n---\n\n# The rail\n'))).toBe('The rail — akapen');
  });

  it('falls back to the file name when the document has no top-level heading', () => {
    expect(pageTitle(doc('## Only a subheading\n'))).toBe('20-auth.md — akapen');
  });

  it('falls back to the file name when the heading is empty', () => {
    expect(pageTitle(doc('#\n\nA paragraph.\n'))).toBe('20-auth.md — akapen');
  });

  it('reads an image in the heading by its alt text', () => {
    expect(pageTitle(doc('# ![Project Logo](logo.png)\n'))).toBe('Project Logo — akapen');
  });

  it('keeps the alt text in place among the words around it', () => {
    expect(pageTitle(doc('# ![Logo](logo.png) and the rail\n'))).toBe('Logo and the rail — akapen');
  });

  it('restores characters the renderer escaped inside an alt text', () => {
    expect(pageTitle(doc('# ![a & b](logo.png)\n'))).toBe('a & b — akapen');
  });

  it('falls back to the file name for an image with no alt text', () => {
    expect(pageTitle(doc('# ![](logo.png)\n'))).toBe('20-auth.md — akapen');
  });

  it('names the file on a path written with backslashes', () => {
    expect(pageTitle(doc('A paragraph.\n', 'C:\\Users\\me\\notes\\20-auth.md'))).toBe('20-auth.md — akapen');
  });

  it('names the file, not the path it sits at', () => {
    expect(pageTitle(doc('A paragraph.\n', '/a/very/long/path/note.md'))).toBe('note.md — akapen');
  });

  it('falls back to the file name when the only heading is quoted', () => {
    expect(pageTitle(doc('> # Quoted\n'))).toBe('20-auth.md — akapen');
  });

  it('is the brand alone when there is neither a heading nor a name', () => {
    expect(pageTitle(doc('A paragraph.\n', ''))).toBe('akapen');
  });
});

/**
 * What `/api/status` reports. Here beside pageTitle rather than in packages/shared, which
 * has no parser to build a document with.
 */
describe('documentTitle', () => {
  it('is the first heading with the markup taken off', () => {
    expect(documentTitle(doc('# The **rail**\n\n# Second\n'))).toBe('The rail');
  });

  it('is empty rather than the file name when there is no top-level heading', () => {
    expect(documentTitle(doc('## Only a subheading\n'))).toBe('');
  });

  it('passes over a heading inside a quote to the one the document stands under', () => {
    expect(documentTitle(doc('> # Quoted\n\n# Real\n'))).toBe('Real');
  });

  it('passes over a heading inside a list item', () => {
    expect(documentTitle(doc('- # Listed\n\n# Real\n'))).toBe('Real');
  });

  it('is empty when the only top-level heading is quoted', () => {
    expect(documentTitle(doc('> # Quoted\n\nA paragraph.\n'))).toBe('');
  });

  it('passes over a heading that follows a nested quote inside the same quote', () => {
    expect(documentTitle(doc('> > Nested\n>\n> # Quoted\n\n# Real\n'))).toBe('Real');
  });

  it('is empty when the only top-level heading is in a list', () => {
    expect(documentTitle(doc('- # Listed\n\nA paragraph.\n'))).toBe('');
  });
});

describe('isDocumentHeading', () => {
  // A bare `>` is a line no token covers, so it is filled in as a gap line.
  const blocks = buildDoc('/home/x/n.md', '---\nstatus: draft\n---\n\n>\n\n# Real\n\n> # Quoted\n').blocks;

  it('answers false for frontmatter and gap lines, which always carry depth 0 (#202)', () => {
    const others = blocks.filter((b) => b.kind !== 'heading');
    // Both kinds of block are there, so the answer below is about them and not an empty list.
    expect(others.some((b) => b.kind === 'frontmatter')).toBe(true);
    expect(others.some((b) => b.flags.includes('gap'))).toBe(true);
    expect(others.filter(isDocumentHeading)).toEqual([]);
  });

  it('answers true for a top-level heading and false for a quoted one', () => {
    expect(blocks.filter(isDocumentHeading).map((b) => b.startLine)).toEqual([7]);
  });
});
