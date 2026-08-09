const docEl = document.getElementById('doc');
const railEl = document.getElementById('rail');
const railCloseEl = document.getElementById('railClose');
const filePathEl = document.getElementById('filePath');
const countEl = document.getElementById('count');
const roundEl = document.getElementById('round');
const bannerEl = document.getElementById('banner');
const bannerTextEl = document.getElementById('bannerText');
const nextRoundBtn = document.getElementById('nextRound');
const showLines = document.getElementById('showLines');

let state = { doc: null, comments: [], round: null };
let drag = null; // { start, end } ガター上のドラッグ選択
let draft = null; // { startLine, endLine, text } 入力中のコメント。再描画をまたいで保持する
let active = null; // 選択中の吹き出し (comment id か 'draft')
let mermaidLib = null;

nextRoundBtn.addEventListener('click', async () => {
  nextRoundBtn.disabled = true;
  try {
    await fetch('/api/rounds', { method: 'POST' });
  } finally {
    nextRoundBtn.disabled = false;
  }
});

// live の変更で本文は差し替えない。何回変わったかを出して、進むかどうかは人が決める。
function renderBanner(changed) {
  if (!changed || !changed.dirty) {
    bannerEl.hidden = true;
    return;
  }
  const n = changed.changes;
  bannerTextEl.textContent = n > 1 ? `⟳ 本文が ${n} 回更新されています` : '⟳ 本文が更新されています';
  bannerEl.hidden = false;
}

showLines.addEventListener('change', () => {
  document.body.classList.toggle('show-lines', showLines.checked);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'l' && !e.metaKey && !e.ctrlKey && e.target.tagName !== 'TEXTAREA') {
    showLines.checked = !showLines.checked;
    showLines.dispatchEvent(new Event('change'));
  }
});

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
}

function overlaps(block, startLine, endLine) {
  return block.startLine <= endLine && block.endLine >= startLine;
}

/* ===== 本文 ===== */

function renderDoc() {
  const { doc, comments } = state;
  const fmLines = doc.blocks.filter((b) => b.kind === 'frontmatter');
  const fmFirst = fmLines[0]?.startLine;
  const fmLast = fmLines[fmLines.length - 1]?.startLine;

  docEl.textContent = '';
  for (const block of doc.blocks) {
    const cls = ['row', block.kind, ...block.flags];
    if (block.quoted) cls.push('quoted');
    if (block.startLine === fmFirst) cls.push('fm-first');
    if (block.startLine === fmLast) cls.push('fm-last');
    // 範囲コメントは複数行にまたがるので、重なる行をすべてアンカーとして印を付ける
    const mine = comments.filter((c) => overlaps(block, c.startLine, c.endLine));
    if (mine.length) cls.push('has-comment');

    const row = el('div', cls.join(' '));
    row.dataset.start = block.startLine;
    row.dataset.end = block.endLine;

    const gutter = el('div', 'gutter');
    gutter.append(el('span', 'lineno', String(block.startLine)));
    // レールを畳んでいる間はこのマーカーだけが手がかりになる
    if (mine.length) {
      const marker = el('button', 'marker', String(mine.length));
      marker.title = `${mine.length} 件のコメント`;
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        openRail();
        setActive(mine[0].id, 'rail');
      });
      gutter.append(marker);
    }
    const add = el('button', 'add', '+');
    add.title = `${block.startLine}-${block.endLine} 行にコメント`;
    gutter.append(add);
    row.append(gutter, el('div', 'body', block.html));

    gutter.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('marker')) return;
      e.preventDefault();
      drag = { start: block.startLine, end: block.endLine };
      paintRange();
    });
    row.addEventListener('mouseenter', () => {
      if (!drag) return;
      drag.end = block.endLine;
      paintRange();
    });
    // 本文側からも吹き出しに飛べるようにする (連動は双方向)
    if (mine.length) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        setActive(mine[0].id, 'rail');
      });
    }

    docEl.append(row);
  }
}

function rowFor(line) {
  const rows = [...docEl.querySelectorAll('.row')];
  return (
    rows.find((r) => Number(r.dataset.start) <= line && line <= Number(r.dataset.end)) ??
    rows.find((r) => Number(r.dataset.start) >= line) ??
    rows.at(-1) ??
    null
  );
}

/* ===== 右レール ===== */

function rangeLabel(startLine, endLine) {
  return `L${startLine}${endLine !== startLine ? `-${endLine}` : ''}`;
}

function bubbleFor(c) {
  const box = el('div', `bubble${c.resolved ? ' resolved' : ''}`);
  box.dataset.id = c.id;
  box.dataset.line = c.startLine;

  const head = el('div', 'bubble-head');
  head.append(el('span', 'who', `@${escapeHtml(c.author)}`));
  head.append(el('span', 'at', rangeLabel(c.startLine, c.endLine)));
  const spacer = el('span', null, '');
  spacer.style.flex = '1';
  head.append(spacer);
  const btn = el('button', null, c.resolved ? 'Reopen' : 'Resolve');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await fetch(`/api/comments/${c.id}/resolve`, { method: 'POST' });
  });
  head.append(btn);

  box.append(head, el('div', 'bubble-body', escapeHtml(c.body)));
  box.addEventListener('click', () => setActive(c.id, 'doc'));
  return box;
}

function draftBubble() {
  const { startLine, endLine, text } = draft;
  const box = el('div', 'bubble draft');
  box.dataset.id = 'draft';
  box.dataset.line = startLine;

  const head = el('div', 'bubble-head');
  head.append(el('span', 'at', rangeLabel(startLine, endLine)));
  const spacer = el('span', null, '');
  spacer.style.flex = '1';
  head.append(spacer);
  box.append(head);

  const ta = el('textarea');
  ta.placeholder = 'ここを指摘する…  (Ctrl+Enter で送信)';
  ta.value = text;
  ta.addEventListener('input', () => {
    draft.text = ta.value;
    layoutRail(); // 入力で高さが変わるので下の吹き出しを押し下げ直す
  });

  const actions = el('div', 'bubble-actions');
  const cancel = el('button', null, 'Cancel');
  const submit = el('button', 'primary', 'Comment');
  actions.append(cancel, submit);
  box.append(ta, actions);

  const close = () => {
    draft = null;
    active = null;
    render();
  };
  const send = async () => {
    const body = ta.value.trim();
    if (!body) return close();
    // 送信後は SSE の doc payload で再描画される。draft はここで畳む
    draft = null;
    active = null;
    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine, endLine, body }),
    });
  };
  cancel.addEventListener('click', close);
  submit.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
    if (e.key === 'Escape') close();
  });
  return box;
}

function renderRail() {
  // 閉じるボタンは残す。消すのは吹き出しだけ
  for (const b of [...railEl.querySelectorAll('.bubble')]) b.remove();
  const items = state.comments.map((c) => ({ line: c.startLine, node: () => bubbleFor(c) }));
  if (draft) items.push({ line: draft.startLine, node: draftBubble });
  // アンカー行の順に積まないと「重なったら下にずらす」が意味を成さない
  items.sort((a, b) => a.line - b.line);
  for (const it of items) railEl.append(it.node());
}

/**
 * 吹き出しをアンカー行と垂直に揃える。重なったら下にずらすだけで、本文側は動かさない。
 * 本文に行を挿入しないのがこの機能の要点なので、位置合わせは全部こちら側で吸収する。
 */
function layoutRail() {
  if (document.body.classList.contains('rail-overlay')) {
    for (const b of railEl.querySelectorAll('.bubble')) b.style.top = '';
    railEl.style.height = '';
    return;
  }
  const gap = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ak-bubble-gap'), 10) || 8;
  const railTop = railEl.getBoundingClientRect().top + window.scrollY;
  let cursor = 0;
  for (const b of railEl.querySelectorAll('.bubble')) {
    const row = rowFor(Number(b.dataset.line));
    const want = row ? row.getBoundingClientRect().top + window.scrollY - railTop : cursor;
    const top = Math.max(want, cursor);
    b.style.top = `${top}px`;
    cursor = top + b.offsetHeight + gap;
  }
  railEl.style.height = `${cursor}px`;
}

function setActive(id, scroll) {
  active = id;
  for (const b of railEl.querySelectorAll('.bubble')) b.classList.toggle('active', b.dataset.id === id);
  const target = state.comments.find((c) => c.id === id) ?? (id === 'draft' ? draft : null);
  for (const row of docEl.querySelectorAll('.row')) {
    const s = Number(row.dataset.start);
    const e = Number(row.dataset.end);
    row.classList.toggle('linked', !!target && s <= target.endLine && e >= target.startLine);
  }
  if (!target) return;
  if (scroll === 'doc') rowFor(target.startLine)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (scroll === 'rail') {
    railEl.querySelector(`.bubble[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* ===== 畳んだ状態 (幅が足りない時) ===== */

function openRail() {
  if (!document.body.classList.contains('rail-overlay')) return;
  document.body.classList.add('rail-open');
}
railCloseEl.addEventListener('click', () => document.body.classList.remove('rail-open'));

function syncRailMode() {
  const overlay = !window.matchMedia('(min-width: 1200px)').matches;
  document.body.classList.toggle('rail-overlay', overlay);
  if (!overlay) document.body.classList.remove('rail-open');
}

/* ===== 選択とフォーム ===== */

function paintRange() {
  if (!drag) return;
  const lo = Math.min(drag.start, drag.end);
  const hi = Math.max(drag.start, drag.end);
  for (const row of docEl.querySelectorAll('.row')) {
    const s = Number(row.dataset.start);
    row.classList.toggle('in-range', s >= lo && s <= hi);
  }
}

document.addEventListener('mouseup', () => {
  if (!drag) return;
  const lo = Math.min(drag.start, drag.end);
  const hi = Math.max(drag.start, drag.end);
  drag = null;
  for (const row of docEl.querySelectorAll('.row')) row.classList.remove('in-range');
  draft = { startLine: lo, endLine: hi, text: draft?.text ?? '' };
  render();
  openRail();
  setActive('draft');
  railEl.querySelector('.bubble.draft textarea')?.focus();
});

/* ===== 描画 ===== */

function render() {
  const { doc, comments, round } = state;
  if (!doc) return;
  filePathEl.textContent = doc.path;
  roundEl.textContent = round ? `R${String(round.n).padStart(3, '0')}` : '';
  const open = comments.filter((c) => !c.resolved).length;
  countEl.textContent = `${open} open / ${comments.length}`;

  renderDoc();
  renderRail();
  layoutRail();
  if (active) setActive(active);
  renderMermaid();
}

async function renderMermaid() {
  const nodes = docEl.querySelectorAll('pre.mermaid');
  if (!nodes.length) return;
  if (!mermaidLib) {
    const mod = await import('/vendor/mermaid.min.js');
    mermaidLib = mod.default ?? window.mermaid;
    mermaidLib.initialize({
      startOnLoad: false,
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
    });
  }
  await mermaidLib.run({ nodes });
  layoutRail(); // 図の描画で本文の高さが変わるため必ず貼り直す
}

// 本文の高さが変わったら位置合わせをやり直す (画像・フォント・折り返し幅)
new ResizeObserver(() => layoutRail()).observe(docEl);
window.addEventListener('resize', () => {
  syncRailMode();
  layoutRail();
});

syncRailMode();

const sse = new EventSource('/events');
sse.onmessage = (e) => {
  const payload = JSON.parse(e.data);

  // 本文が変わっただけならバナーを出すだけ。再描画すると読んでいる位置と選択が飛ぶ。
  if (payload.type === 'changed') {
    renderBanner(payload);
    return;
  }

  const y = window.scrollY;
  state = { doc: payload.doc, comments: payload.comments, round: payload.round };
  render();
  renderBanner(payload.changed);
  window.scrollTo(0, y);
};
