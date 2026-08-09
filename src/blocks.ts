// markdown-it 15 は型を同梱している。旧 @types/markdown-it のサブパス
// ('markdown-it/lib/token.mjs') は解決できないので、本体から取る。
import MarkdownIt, { type Token } from 'markdown-it';
import hljs from 'highlight.js';

export type BlockKind =
  | 'frontmatter'
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'table-row'
  | 'code'
  | 'mermaid'
  | 'hr'
  | 'html';

export type Block = {
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  kind: BlockKind;
  html: string;
  text: string; // raw source of the range — the re-anchoring key
  depth: number; // list / blockquote nesting
  quoted: boolean;
  flags: string[];
};

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

/**
 * crit は typographer を有効にしているため frontmatter の "..." が “...” に化ける。
 * こちらは素の文字を保つ。レビュー対象は原文であって組版ではない。
 */

export type Doc = {
  path: string;
  blocks: Block[];
  lineCount: number;
};

const FM_FENCE = /^---\s*$/;

/** frontmatter の範囲を返す。無ければ null。 */
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
 * frontmatter を 1 ソース行 = 1 ブロックで描く。
 * crit は素通しして本文扱いするため key: value が段落に融合し、行単位で指せなくなる。
 * ここでは行を融合させないことを最優先にする (値の途中で折り返した行も独立して指せる)。
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

/** ハイライト済み HTML を行単位に割る。行をまたぐ span を各行で開き直す。 */
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

/** fence を 1 行 = 1 ブロックに割る。行番号を保ちつつコード全体の見た目を維持する。 */
function walkFence(token: Token, ctx: Ctx): void {
  const [start, end] = token.map ?? [0, 0];
  const startLine = start + 1;
  const endLine = end; // fence は開始/終了行を含む
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
  // 開始フェンス行
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

/** 表を 1 行 = 1 ブロックに割る。列幅は table-layout: fixed で行をまたいで揃う。 */
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
          // markdown-it 15 の attrs は number も取りうる (align は文字列だが型上は string | number)
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
      // markdown の区切り行 (|---|---|) はトークンにならないので、ヘッダ行の次を明示的に足す
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

    // 項目自身の 1 行目 (最初の paragraph の inline) をブロックにする
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
        restStart = j + 2; // paragraph_close の次
        break;
      }
      if (c.type !== 'paragraph_open') break; // 項目がリスト / 表 / フェンスで始まる場合
    }

    // 残りの子 (ネストしたリスト・表・フェンス・引用・継続段落) は同じ walk に通す。
    // 種類を数え上げると必ず取りこぼす — 実際に表がリスト内にあるノートで落ちた。
    ctx.depth++;
    walk(tokens.slice(restStart, itemClose), ctx);
    ctx.depth--;

    index++;
    i = itemClose;
  }
  return closeIdx;
}

/** 段落は 1 ソース行 = 1 ブロックに割る。行が融合するとその粒度でしか指せなくなるため。 */
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
      case 'html_block': {
        const [s, e] = t.map ?? [0, 0];
        push(ctx, { startLine: s + 1, endLine: e, kind: 'html', html: t.content, flags: [] });
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
    // 行番号を保つため frontmatter は空行に置き換えてから解析する
    const blanked = lines.slice();
    for (let ln = fm.start; ln <= fm.end; ln++) blanked[ln - 1] = '';
    body = blanked.join('\n');
  }

  const ctx: Ctx = { lines, out, depth: 0, quoted: false };
  walk(md.parse(body, {}), ctx);

  // トークンにならない行 (引用内の "> " だけの行など) を拾う。
  // 「空行以外のすべての行はどれかのブロックに属する」を不変条件として守る。
  // ここが崩れると、指したい行が画面に存在しないという最悪の壊れ方をする。
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
