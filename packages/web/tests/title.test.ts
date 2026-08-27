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

  it('is the brand alone when there is neither a heading nor a name', () => {
    expect(pageTitle(doc('A paragraph.\n', ''))).toBe('akapen');
  });
});
