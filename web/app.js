import { bindKeys, loadKeymap } from './keys.js';

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
let drag = null; // { start, end } ガター上のドラッグ中だけ立つ
// 選択範囲。マウスもキーボードも最終的にここを動かし、startDraft に入る。
// 経路を 1 本にしないと「マウスでは範囲が取れるがキーボードでは取れない」がすぐ生える。
let sel = null; // { start, end }
let focusLine = null; // キーボードで動かしている行 (先頭行の行番号)
let draft = null; // { startLine, endLine, text } 入力中のコメント。再描画をまたいで保持する
let active = null; // 選択中の吹き出し (comment id か 'draft')
let mermaidLib = null;

nextRoundBtn.addEventListener('click', async () => {
  nextRoundBtn.disabled = true;
  try {
    const res = await fetch('/api/rounds', { method: 'POST' });
    if (!res.ok) bannerTextEl.textContent = `ラウンドを切れませんでした (HTTP ${res.status})`;
  } catch (err) {
    bannerTextEl.textContent = `ラウンドを切れませんでした (${err.message})`;
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

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
}

// 失敗を console だけに落とすと、押した本人には何も起きていないように見える
function fail(box, message) {
  box.querySelector('.bubble-error')?.remove();
  box.append(el('div', 'bubble-error', escapeHtml(message)));
  layoutRail();
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
    // j/k で移動した行に DOM フォーカスも移す。Tab 順を 159 行ぶん汚さないよう -1。
    // コメントの付いた行だけは下で 0 にして Tab でも辿れるようにしている
    row.tabIndex = -1;

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
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      drag = null;
      focusLine = block.startLine;
      sel = { start: block.startLine, end: block.endLine };
      startDraft();
    });
    gutter.append(add);
    row.append(gutter, el('div', 'body', block.html));

    gutter.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('marker')) return;
      e.preventDefault();
      drag = { start: block.startLine, end: block.endLine };
      sel = { ...drag };
      focusLine = block.startLine;
      paintSelection();
    });
    row.addEventListener('mouseenter', () => {
      if (!drag) return;
      drag.end = block.endLine;
      sel = { start: drag.start, end: drag.end };
      paintSelection();
    });
    // 本文側からも吹き出しに飛べるようにする (連動は双方向)
    if (mine.length) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('a, button')) return;
        setActive(mine[0].id, 'rail');
      });
      row.tabIndex = 0;
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
    btn.disabled = true;
    try {
      const res = await fetch(`/api/comments/${c.id}/resolve`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      btn.disabled = false;
      fail(box, `更新に失敗しました (${err.message})`);
    }
  });
  head.append(btn);

  box.append(head, el('div', 'bubble-body', escapeHtml(c.body)));
  // 折りたたんだ本文を開く手段がマウスだけだと、キーボードでは 12em 以降が読めない
  box.tabIndex = 0;
  box.addEventListener('click', () => setActive(c.id, 'doc'));
  box.addEventListener('focus', () => setActive(c.id));
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
  ta.setAttribute('aria-label', `${rangeLabel(startLine, endLine)} 行へのコメント`);
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
    if (submit.disabled) return; // Ctrl+Enter 連打で二重投稿しない
    submit.disabled = true;
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startLine, endLine, body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // 下書きは残す。捨てると打った内容を取り戻す手段が無くなる
      submit.disabled = false;
      fail(box, `送信に失敗しました (${err.message})`);
      return;
    }
    // SSE の doc payload を待たずに畳む。待つと下書きが残って二重投稿の窓ができる
    draft = null;
    active = null;
    // 選択は畳むが行フォーカスは残す。連続して打つ時に位置が飛ぶと使えない
    sel = null;
    render();
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
 *
 * 読み (rect / offsetHeight) と書き (style.top) を分けている。混ぜるとバブルごとに
 * 強制同期レイアウトが走り、textarea の 1 文字ごとに呼ばれるこの関数が長い文書で目に見えて遅くなる。
 */
function layoutRail() {
  const bubbles = [...railEl.querySelectorAll('.bubble')];
  if (!bubbles.length || document.body.classList.contains('rail-overlay')) {
    for (const b of bubbles) b.style.top = '';
    railEl.style.height = '';
    return;
  }

  // --- 読み ---
  const rows = [...docEl.querySelectorAll('.row')].map((r) => ({
    start: Number(r.dataset.start),
    end: Number(r.dataset.end),
    top: r.getBoundingClientRect().top,
  }));
  const railTop = railEl.getBoundingClientRect().top;
  const heights = bubbles.map((b) => b.offsetHeight);
  const gap = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ak-bubble-gap'), 10) || 8;

  // --- 計算 --- 吹き出しも行も行番号順なので、行側は 1 本のポインタで舐めれば足りる
  const tops = [];
  let cursor = 0;
  let ri = 0;
  for (const [i, b] of bubbles.entries()) {
    const line = Number(b.dataset.line);
    while (ri < rows.length - 1 && rows[ri].end < line) ri++;
    const want = rows[ri] ? rows[ri].top - railTop : cursor;
    const top = Math.max(want, cursor);
    tops.push(top);
    cursor = top + heights[i] + gap;
  }

  // --- 書き ---
  for (const [i, b] of bubbles.entries()) b.style.top = `${tops[i]}px`;
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
  // active は .bubble-body の折りたたみを外すので高さが変わる。位置合わせを貼り直す
  layoutRail();
  if (!target) return;
  if (scroll === 'doc') rowFor(target.startLine)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (scroll === 'rail') {
    railEl.querySelector(`.bubble[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* ===== 畳んだ状態 (幅が足りない時) ===== */

// 畳んだレールは画面外に出るだけで DOM に残る。inert を外し忘れると
// Tab が画面外のボタンに入り、フォーカスの居場所が分からなくなる
function openRail() {
  if (!document.body.classList.contains('rail-overlay')) return;
  document.body.classList.add('rail-open');
  railEl.inert = false;
}
railCloseEl.addEventListener('click', () => {
  document.body.classList.remove('rail-open');
  railEl.inert = true;
});

// style.css の @media (max-width: 1199px) と同じ条件。別々に書くと 1199.5px のような
// 小数幅で CSS と JS の判定が食い違い、全吹き出しが同じ位置に重なる
const railOverlayQuery = window.matchMedia('(max-width: 1199px)');

function syncRailMode() {
  const overlay = railOverlayQuery.matches;
  document.body.classList.toggle('rail-overlay', overlay);
  if (!overlay) document.body.classList.remove('rail-open');
  railEl.inert = overlay && !document.body.classList.contains('rail-open');
}

/* ===== 選択とフォーム ===== */
/* マウスもキーボードも sel を動かして startDraft を呼ぶ。入口は 1 つに保つ */

function paintSelection() {
  const lo = sel ? Math.min(sel.start, sel.end) : null;
  const hi = sel ? Math.max(sel.start, sel.end) : null;
  for (const row of docEl.querySelectorAll('.row')) {
    const s = Number(row.dataset.start);
    row.classList.toggle('in-range', sel !== null && s >= lo && s <= hi);
    row.classList.toggle('focused', s === focusLine);
  }
}

function clearSelection() {
  sel = null;
  paintSelection();
}

function startDraft() {
  if (!sel) return;
  const lo = Math.min(sel.start, sel.end);
  const hi = Math.max(sel.start, sel.end);
  draft = { startLine: lo, endLine: hi, text: draft?.text ?? '' };
  render();
  openRail();
  setActive('draft');
  railEl.querySelector('.bubble.draft textarea')?.focus();
}

document.addEventListener('mouseup', () => {
  if (!drag) return;
  drag = null;
  startDraft();
});

/* ===== 行フォーカス (キーボード動線) ===== */

function lineNumbers() {
  return [...docEl.querySelectorAll('.row')].map((r) => Number(r.dataset.start));
}

/** step ぶん行を移動する。extend が真なら選択範囲を伸ばし、偽なら 1 行に畳む */
function moveFocus(step, extend) {
  const lines = lineNumbers();
  if (!lines.length) return;
  if (focusLine === null) {
    focusLine = lines[0];
  } else {
    const i = lines.indexOf(focusLine);
    const next = i < 0 ? 0 : Math.min(Math.max(i + step, 0), lines.length - 1);
    focusLine = lines[next];
  }
  const anchor = extend && sel ? sel.start : focusLine;
  sel = { start: anchor, end: focusLine };
  paintSelection();
  const row = docEl.querySelector(`.row[data-start="${focusLine}"]`);
  row?.scrollIntoView({ block: 'nearest' });
  row?.focus({ preventScroll: true });
}

/* ===== 描画 ===== */

function render() {
  const { doc, comments, round } = state;
  if (!doc) return;
  filePathEl.textContent = doc.path;
  roundEl.textContent = round ? `R${String(round.n).padStart(3, '0')}` : '';
  const open = comments.filter((c) => !c.resolved).length;
  countEl.textContent = `${open} open / ${comments.length}`;

  renderDoc();
  paintSelection();
  renderRail();
  if (active) setActive(active);
  else layoutRail();
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
railOverlayQuery.addEventListener('change', () => {
  syncRailMode();
  layoutRail();
});
window.addEventListener('resize', () => layoutRail());

syncRailMode();

/* ===== キーマップ =====
 * 割り当ては web/keys.js。ここは動作の実体だけを持つ。
 * マウス動線と同じ関数 (startDraft / setActive) を呼び、経路を分岐させない。
 */
const ACTIONS = {
  'row.next': () => moveFocus(1, false),
  'row.prev': () => moveFocus(-1, false),
  'row.extendNext': () => moveFocus(1, true),
  'row.extendPrev': () => moveFocus(-1, true),
  'comment.start': () => {
    if (focusLine === null) moveFocus(0, false);
    if (!sel) return false;
    startDraft();
  },
  'comment.submit': () => {
    const btn = railEl.querySelector('.bubble.draft button.primary');
    if (!btn) return false; // 入力中でなければ既定動作を邪魔しない
    btn.click();
  },
  'comment.cancel': () => {
    const btn = railEl.querySelector('.bubble.draft button:not(.primary)');
    if (btn) btn.click();
    else if (document.body.classList.contains('rail-open')) railCloseEl.click();
    else if (sel) clearSelection();
    else return false;
  },
  'lines.toggle': () => {
    showLines.checked = !showLines.checked;
    showLines.dispatchEvent(new Event('change'));
  },
};

loadKeymap().then((keymap) => bindKeys(keymap, ACTIONS));

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
