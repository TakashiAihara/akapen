// markdown-it 15 ships its own types. The old @types/markdown-it subpath
// ('markdown-it/lib/token.mjs') does not resolve, so take Token from the package.
import MarkdownIt, { type Token } from 'markdown-it';
import type { Block, BlockKind, Doc } from '../shared/types.ts';
import hljs from 'highlight.js';

/**
 * html: false. HTML written directly in the markdown is escaped and shown as text.
 *
 * What akapen renders is markdown under review, and it does not always come from
 * you. With html: true the document goes straight into innerHTML, so opening a
 * file runs arbitrary JS on akapen's origin — which serves an unauthenticated
 * /api/comments and an /api/doc that returns the absolute path.
 *
 * Leaving a hole for non-markdown to slip into a markdown reader buys less than
 * closing it.
 */
const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

/**
 * crit enables typographer, so "..." in frontmatter turns into “...”. We keep the
 * characters as written: what is under review is the source, not its typesetting.
 */

export type { Block, BlockKind, Doc };

const FM_FENCE = /^---\s*$/;

/** The frontmatter range, or null when there is none. */
function frontmatterRange(lines: string[]): { start: number; end: number } | null {
  if (lines.length === 0 || !FM_FENCE.test(lines[0]!)) return null;
  for (let i = 1; i < lines.length; i++) {
    if (FM_FENCE.test(lines[i]!)) return { start: 1, end: i + 1 }; // 1-based, delimiters included
  }
  return null;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render frontmatter as one source line = one block.
 * crit passes it through as body text, so `key: value` merges into a paragraph and
 * you can no longer point at a single line. Not merging lines is the priority here
 * (even a line wrapped mid-value stays independently addressable).
 */
function frontmatterBlocks(lines: string[], range: { start: number; end: number }): Block[] {
  const out: Block[] = [];
  for (let ln = range.start; ln <= range.end; ln++) {
    const raw = lines[ln - 1] ?? '';
    const isFence = FM_FENCE.test(raw);
    let html: string;
    if (isFence) {
      html = `<div class="fm-fence"></div>`;
    } else {
      const m = /^(\s*)([A-Za-z0-9_.-]+):(\s*)(.*)$/.exec(raw);
      if (m) {
        const [, indent, key, , value] = m;
        html =
          `<div class="fm-row" style="--indent:${indent!.length}">` +
          `<span class="fm-key">${esc(key!)}</span>` +
          (value ? `<span class="fm-value">${esc(value)}</span>` : '') +
          `</div>`;
      } else {
        const item = /^(\s*)-\s+(.*)$/.exec(raw);
        html = item
          ? `<div class="fm-row fm-item" style="--indent:${item[1]!.length}"><span class="fm-value">${esc(item[2]!)}</span></div>`
          : `<div class="fm-row"><span class="fm-value">${esc(raw)}</span></div>`;
      }
    }
    out.push({
      startLine: ln,
      endLine: ln,
      kind: 'frontmatter',
      html,
      text: raw,
      depth: 0,
      quoted: false,
      flags: isFence ? ['fm-fence'] : [],
    });
  }
  return out;
}

/** Split highlighted HTML per line, reopening spans that straddle a line break. */
function splitHighlighted(html: string): string[] {
  const lines = html.split('\n');
  const out: string[] = [];
  const open: string[] = [];
  for (const line of lines) {
    const prefix = open.join('');
    const re = /<\/?span[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m[0].startsWith('</')) open.pop();
      else open.push(m[0]);
    }
    const suffix = '</span>'.repeat(open.length);
    out.push(prefix + line + suffix);
  }
  return out;
}

function highlight(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      /* fall through */
    }
  }
  return esc(code);
}

type Ctx = { lines: string[]; out: Block[]; depth: number; quoted: boolean };

function rawRange(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

function push(ctx: Ctx, b: Omit<Block, 'text' | 'depth' | 'quoted'> & Partial<Pick<Block, 'text'>>): void {
  ctx.out.push({
    depth: ctx.depth,
    quoted: ctx.quoted,
    text: b.text ?? rawRange(ctx.lines, b.startLine, b.endLine),
    ...b,
  } as Block);
}

function findClose(tokens: Token[], openIdx: number): number {
  const type = tokens[openIdx]!.type;
  const closeType = type.replace(/_open$/, '_close');
  let level = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === type) level++;
    else if (t.type === closeType) {
      level--;
      if (level === 0) return i;
    }
  }
  return tokens.length - 1;
}

function renderInline(token: Token | undefined): string {
  if (!token) return '';
  return md.renderer.renderInline(token.children ?? [], md.options, {});
}

/** Split a fence into one block per line, keeping line numbers while the code still looks like one unit. */
function walkFence(token: Token, ctx: Ctx): void {
  const [start, end] = token.map ?? [0, 0];
  const startLine = start + 1;
  const endLine = end; // the fence includes its opening and closing lines
  const info = (token.info || '').trim().split(/\s+/)[0] ?? '';

  if (info === 'mermaid') {
    push(ctx, {
      startLine,
      endLine,
      kind: 'mermaid',
      html: `<div class="mermaid-block"><pre class="mermaid">${esc(token.content.replace(/\n$/, ''))}</pre></div>`,
      flags: [],
    });
    return;
  }

  const codeLines = splitHighlighted(highlight(token.content.replace(/\n$/, ''), info));
  // opening fence line
  push(ctx, {
    startLine,
    endLine: startLine,
    kind: 'code',
    html: `<div class="code-line code-fence">${esc(ctx.lines[startLine - 1] ?? '')}</div>`,
    flags: ['code-first'],
  });
  codeLines.forEach((h, i) => {
    const ln = startLine + 1 + i;
    push(ctx, {
      startLine: ln,
      endLine: ln,
      kind: 'code',
      html: `<div class="code-line"><code>${h || '&nbsp;'}</code></div>`,
      flags: [],
    });
  });
  const lastLine = endLine;
  if (lastLine > startLine + codeLines.length) {
    push(ctx, {
      startLine: lastLine,
      endLine: lastLine,
      kind: 'code',
      html: `<div class="code-line code-fence">${esc(ctx.lines[lastLine - 1] ?? '')}</div>`,
      flags: ['code-last'],
    });
  }
}

/** Split a table into one block per row. `table-layout: fixed` keeps columns aligned across rows. */
function walkTable(tokens: Token[], openIdx: number, ctx: Ctx): number {
  const closeIdx = findClose(tokens, openIdx);
  let colCount = 0;
  for (let i = openIdx; i <= closeIdx; i++) {
    const t = tokens[i]!;
    if (t.type === 'tr_open') {
      const trClose = findClose(tokens, i);
      const cells: { html: string; tag: 'th' | 'td'; align: string }[] = [];
      for (let j = i + 1; j < trClose; j++) {
        const c = tokens[j]!;
        if (c.type === 'th_open' || c.type === 'td_open') {
          // markdown-it 15 attrs can hold numbers (align is a string, but the type is string | number).
          const style = String(c.attrGet('style') ?? '');
          cells.push({
            tag: c.type === 'th_open' ? 'th' : 'td',
            html: renderInline(tokens[j + 1]),
            align: style,
          });
        }
      }
      colCount = Math.max(colCount, cells.length);
      const [s, e] = t.map ?? [0, 0];
      const isHeader = cells[0]?.tag === 'th';
      const cellsHtml = cells
        .map((c) => `<${c.tag}${c.align ? ` style="${c.align}"` : ''}>${c.html}</${c.tag}>`)
        .join('');
      push(ctx, {
        startLine: s + 1,
        endLine: e,
        kind: 'table-row',
        html: `<table class="split-table"><tbody><tr>${cellsHtml}</tr></tbody></table>`,
        flags: isHeader ? ['table-header'] : [],
      });
      // The separator row (|---|---|) produces no token, so add it explicitly after the header
      if (isHeader) {
        const sepLine = e + 1;
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(ctx.lines[sepLine - 1] ?? '')) {
          push(ctx, {
            startLine: sepLine,
            endLine: sepLine,
            kind: 'table-row',
            html: '<div class="table-separator"></div>',
            flags: ['table-separator'],
          });
        }
      }
      i = trClose;
    }
  }
  return closeIdx;
}

function walkList(tokens: Token[], openIdx: number, ctx: Ctx): number {
  const open = tokens[openIdx]!;
  const closeIdx = findClose(tokens, openIdx);
  const ordered = open.type === 'ordered_list_open';
  let index = Number(open.attrGet('start') ?? 1);

  for (let i = openIdx + 1; i < closeIdx; i++) {
    const t = tokens[i]!;
    if (t.type !== 'list_item_open') continue;
    const itemClose = findClose(tokens, i);

    // The item's own first line (the inline of its first paragraph) becomes a block
    let restStart = i + 1;
    for (let j = i + 1; j < itemClose; j++) {
      const c = tokens[j]!;
      if (c.type === 'inline' && tokens[j - 1]?.type === 'paragraph_open') {
        const [s, e] = c.map ?? [0, 0];
        const marker = ordered ? `${index}.` : '•';
        push(ctx, {
          startLine: s + 1,
          endLine: e,
          kind: 'list-item',
          html:
            `<div class="li" style="--depth:${ctx.depth}">` +
            `<span class="li-marker">${esc(marker)}</span>` +
            `<span class="li-body">${renderInline(c)}</span></div>`,
          flags: [],
        });
        restStart = j + 2; // just past paragraph_close
        break;
      }
      if (c.type !== 'paragraph_open') break; // the item starts with a list, table or fence
    }

    // Send the remaining children (nested lists, tables, fences, quotes, continuation
    // paragraphs) through the same walk. Enumerating kinds always misses something —
    // it broke on a real note that had a table inside a list.
    ctx.depth++;
    walk(tokens.slice(restStart, itemClose), ctx);
    ctx.depth--;

    index++;
    i = itemClose;
  }
  return closeIdx;
}

/** Split paragraphs into one block per source line. Merged lines can only be addressed at that coarser grain. */
function walkParagraph(inline: Token, ctx: Ctx): void {
  const [s, e] = inline.map ?? [0, 0];
  for (let ln = s + 1; ln <= e; ln++) {
    const raw = ctx.lines[ln - 1] ?? '';
    if (!raw.trim()) continue;
    push(ctx, {
      startLine: ln,
      endLine: ln,
      kind: 'paragraph',
      html: `<p>${md.renderInline(raw)}</p>`,
      flags: [],
    });
  }
}

function walk(tokens: Token[], ctx: Ctx): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t.type) {
      case 'heading_open': {
        const inline = tokens[i + 1];
        const [s, e] = t.map ?? [0, 0];
        push(ctx, {
          startLine: s + 1,
          endLine: e,
          kind: 'heading',
          html: `<${t.tag}>${renderInline(inline)}</${t.tag}>`,
          flags: [t.tag],
        });
        i = findClose(tokens, i);
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        if (inline?.type === 'inline') walkParagraph(inline, ctx);
        i = findClose(tokens, i);
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open':
        i = walkList(tokens, i, ctx);
        break;
      case 'table_open':
        i = walkTable(tokens, i, ctx);
        break;
      case 'blockquote_open': {
        const closeIdx = findClose(tokens, i);
        ctx.quoted = true;
        walk(tokens.slice(i + 1, closeIdx), ctx);
        ctx.quoted = false;
        i = closeIdx;
        break;
      }
      case 'fence':
        walkFence(t, ctx);
        break;
      case 'code_block': {
        const [s, e] = t.map ?? [0, 0];
        for (let ln = s + 1; ln <= e; ln++) {
          push(ctx, {
            startLine: ln,
            endLine: ln,
            kind: 'code',
            html: `<div class="code-line"><code>${esc(ctx.lines[ln - 1] ?? '')}</code></div>`,
            flags: [],
          });
        }
        break;
      }
      case 'hr': {
        const [s, e] = t.map ?? [0, 0];
        push(ctx, { startLine: s + 1, endLine: e, kind: 'hr', html: '<hr>', flags: [] });
        break;
      }
      default:
        break;
    }
  }
}

export function buildDoc(path: string, source: string): Doc {
  const lines = source.split('\n');
  const fm = frontmatterRange(lines);
  const out: Block[] = [];

  let body = source;
  if (fm) {
    out.push(...frontmatterBlocks(lines, fm));
    // Blank out the frontmatter before parsing so line numbers stay intact
    const blanked = lines.slice();
    for (let ln = fm.start; ln <= fm.end; ln++) blanked[ln - 1] = '';
    body = blanked.join('\n');
  }

  const ctx: Ctx = { lines, out, depth: 0, quoted: false };
  walk(md.parse(body, {}), ctx);

  // Pick up lines that produce no token (a bare "> " inside a quote, for example).
  // The invariant is that every non-blank line belongs to exactly one block.
  // Break it and you get the worst failure there is: the line you want to point at
  // is not on the screen.
  const covered = new Set<number>();
  for (const b of out) for (let ln = b.startLine; ln <= b.endLine; ln++) covered.add(ln);
  for (let ln = 1; ln <= lines.length; ln++) {
    const raw = lines[ln - 1]!;
    if (!raw.trim() || covered.has(ln)) continue;
    const quoted = /^\s*>/.test(raw);
    const stripped = raw.replace(/^\s*>+\s?/, '');
    out.push({
      startLine: ln,
      endLine: ln,
      kind: 'paragraph',
      html: stripped.trim() ? `<p>${md.renderInline(stripped)}</p>` : '<p class="gap-line"></p>',
      text: raw,
      depth: 0,
      quoted,
      flags: ['gap'],
    });
  }

  out.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return { path, blocks: out, lineCount: lines.length };
}
