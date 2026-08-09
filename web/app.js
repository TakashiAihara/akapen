import { bindKeys, loadKeymap } from './keys.js';

const docEl = document.getElementById('doc');
const railEl = document.getElementById('rail');
const anchoredEl = document.getElementById('railAnchored');
const carriedEl = document.getElementById('railCarried');
const roundPickEl = document.getElementById('roundPick');
const historyBarEl = document.getElementById('historyBar');
const historyTextEl = document.getElementById('historyText');
const backBtn = document.getElementById('backToCurrent');
const railCloseEl = document.getElementById('railClose');
const filePathEl = document.getElementById('filePath');
const countEl = document.getElementById('count');
const roundEl = document.getElementById('round');
const bannerEl = document.getElementById('banner');
const bannerTextEl = document.getElementById('bannerText');
const nextRoundBtn = document.getElementById('nextRound');
const showLines = document.getElementById('showLines');

// viewing は「いま画面に出しているラウンド」。現ラウンドと違う間は読み取り専用。
let state = { doc: null, comments: [], round: null, carried: [], history: false };
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // ラウンドが変われば本文も変わる。ここは本文ごと差し替えてよい (人が押した結果なので)
    draft = null;
    sel = null;
    focusLine = null;
    active = null;
    applyPayload(await res.json());
  } catch (err) {
    bannerTextEl.textContent = `ラウンドを切れませんでした (${err.message})`;
  } finally {
    nextRoundBtn.disabled = false;
  }
});

/** コメントだけが変わった時の更新。本文には触らない。 */
function applyComments(payload) {
  state = { ...state, comments: payload.comments ?? state.comments, carried: payload.carried ?? state.carried };
  markCommentedRows();
  renderRail();
  layoutRail();
  updateCount();
}

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
    if (mine.length) gutter.append(makeMarker(mine));
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
    row.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      // クリックも j/k と同じ経路に入れる。ここを繋がないと、行を選んでから c を押しても
      // 先頭行にコメントが付く (マウスとキーボードで動線が割れる)
      focusLine = block.startLine;
      sel = { start: block.startLine, end: block.endLine };
      paintSelection();
      const now = state.comments.find((c) => block.startLine <= c.endLine && block.endLine >= c.startLine);
      if (now) setActive(now.id, 'rail');
    });
    if (mine.length) row.tabIndex = 0;

    docEl.append(row);
  }
}

/** コメントの有無で行の印だけ塗り直す。本文の DOM は作り直さない。 */
function markCommentedRows() {
  for (const row of docEl.querySelectorAll('.row')) {
    const s = Number(row.dataset.start);
    const e = Number(row.dataset.end);
    const mine = state.comments.filter((c) => s <= c.endLine && e >= c.startLine);
    row.classList.toggle('has-comment', mine.length > 0);
    const gutter = row.querySelector('.gutter');
    const marker = gutter.querySelector('.marker');
    if (!mine.length) {
      marker?.remove();
    } else if (marker) {
      marker.textContent = String(mine.length);
      marker.title = `${mine.length} 件のコメント`;
    } else {
      gutter.insertBefore(makeMarker(mine), gutter.querySelector('.add'));
    }
  }
}

function updateCount() {
  const open = state.comments.filter((c) => !c.resolved).length;
  const carried = state.carried.length;
  countEl.textContent = `${open} open / ${state.comments.length}${carried ? ` (+ 過去 ${carried})` : ''}`;
}

function makeMarker(mine) {
  const marker = el('button', 'marker', String(mine.length));
  marker.title = `${mine.length} 件のコメント`;
  marker.addEventListener('click', (e) => {
    e.stopPropagation();
    openRail();
    // クリック時点のコメントを引き直す。行は作り直さないので古い配列を掴んだままになる
    const row = marker.closest('.row');
    const s = Number(row.dataset.start);
    const e2 = Number(row.dataset.end);
    const now = state.comments.find((c) => s <= c.endLine && e2 >= c.startLine);
    if (now) setActive(now.id, 'rail');
  });
  return marker;
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

function bubbleFor(c, opts = {}) {
  const box = el('div', `bubble${c.resolved ? ' resolved' : ''}${opts.past ? ' past' : ''}`);
  box.dataset.id = c.id;
  box.dataset.line = c.startLine;

  const head = el('div', 'bubble-head');
  head.append(el('span', 'who', `@${escapeHtml(c.author)}`));
  if (opts.past) {
    // どのラウンドのどの行に対する指摘かを持たせる。押すとその当時の本文へ飛ぶ
    const tag = el('button', 'round-tag', `R${String(c.round).padStart(3, '0')}`);
    tag.title = `R${String(c.round).padStart(3, '0')} の本文を見る`;
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      showRound(c.round, c.id);
    });
    head.append(tag);
  }
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
      if (!state.history) applyComments(await res.json());
      else showRound(state.round.viewing);
    } catch (err) {
      btn.disabled = false;
      fail(box, `更新に失敗しました (${err.message})`);
    }
  });
  head.append(btn);

  box.append(head, el('div', 'bubble-body', escapeHtml(c.body)));
  // 折りたたんだ本文を開く手段がマウスだけだと、キーボードでは 12em 以降が読めない
  box.tabIndex = 0;
  box.addEventListener('click', () => (opts.past ? showRound(c.round, c.id) : setActive(c.id, 'doc')));
  box.addEventListener('focus', () => setActive(c.id));
  return box;
}

function draftBubble() {
  const { startLine, endLine, text } = draft;
  const box = el('div', 'bubble draft');
  box.dataset.id = 'draft';
  box.dataset.line = startLine;
  // send() は作成時の範囲を閉じ込めるので、再利用の判定には終了行も要る。
  // 開始行だけで見ると、範囲を伸ばした時に古い範囲で投稿される
  box.dataset.end = endLine;

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
    renderRail();
    layoutRail();
  };
  let posted = null;
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
      posted = await res.json();
    } catch (err) {
      // 下書きは残す。捨てると打った内容を取り戻す手段が無くなる
      submit.disabled = false;
      fail(box, `送信に失敗しました (${err.message})`);
      return;
    }
    draft = null;
    active = null;
    // 選択は畳むが行フォーカスは残す。連続して打つ時に位置が飛ぶと使えない
    sel = null;
    paintSelection();
    applyComments(posted);
  };
  cancel.addEventListener('click', close);
  submit.addEventListener('click', send);
  // Ctrl+Enter / Escape はここに書かない。keys.js の comment.submit / comment.cancel が
  // 下のボタンを押す。二重に持つと片方だけ IME ガードが抜ける (実際に抜けていた)
  return box;
}

/**
 * 下書きの吹き出しだけは作り直さず、DOM に置いたまま残す。
 *
 * IME で変換中の textarea は、DOM から外れた時点で変換が打ち切られる。退避して戻す形も
 * 同じなので、そもそも触らない。フォーカスとキャレット (#26) もこれで自然に残る。
 */
function renderRail() {
  for (const b of anchoredEl.querySelectorAll('.bubble:not(.draft)')) b.remove();

  const existing = anchoredEl.querySelector('.bubble.draft');
  if (!draft) {
    existing?.remove();
  } else if (
    !existing ||
    existing.dataset.line !== String(draft.startLine) ||
    existing.dataset.end !== String(draft.endLine)
  ) {
    // 対象範囲が変わった時だけ作り直す。この時は変換中でないので外して問題ない
    existing?.remove();
    anchoredEl.append(draftBubble());
  }

  // 行順に積む。位置合わせは data-line でやるので描画には効かないが、
  // Tab の順序は DOM 順なので、揃えないとキーボードで飛び回ることになる
  for (const c of [...state.comments].sort((a, b) => a.startLine - b.startLine)) {
    anchoredEl.append(bubbleFor(c));
  }
  renderCarried();
}

/**
 * 過去ラウンドの未解決コメント。現ラウンドの本文にアンカーが無いので位置は合わせられない。
 * それでも出すのは、持ち越さない設計では「画面から消えた = 解決した」に見えてしまうため。
 */
function renderCarried() {
  carriedEl.textContent = '';
  const carried = state.history ? [] : state.carried;
  if (!carried.length) {
    carriedEl.hidden = true;
    return;
  }
  carriedEl.hidden = false;
  const h = el('h2', null, `過去ラウンドの未解決 ${carried.length} 件`);
  carriedEl.append(h);
  for (const c of carried) carriedEl.append(bubbleFor(c, { past: true }));
}

/**
 * 吹き出しをアンカー行と垂直に揃える。重なったら下にずらすだけで、本文側は動かさない。
 * 本文に行を挿入しないのがこの機能の要点なので、位置合わせは全部こちら側で吸収する。
 *
 * 読み (rect / offsetHeight) と書き (style.top) を分けている。混ぜるとバブルごとに
 * 強制同期レイアウトが走り、textarea の 1 文字ごとに呼ばれるこの関数が長い文書で目に見えて遅くなる。
 */
function layoutRail() {
  // 下書きを動かさないため DOM の順序は当てにできない。アンカー行で並べ替えてから積む。
  // 順序が崩れると「重なったら下にずらす」が意味を成さない。
  const bubbles = [...anchoredEl.querySelectorAll('.bubble')].sort(
    (a, b) => Number(a.dataset.line) - Number(b.dataset.line),
  );
  if (!bubbles.length || document.body.classList.contains('rail-overlay')) {
    for (const b of bubbles) b.style.top = '';
    anchoredEl.style.height = '';
    return;
  }

  // --- 読み ---
  const rows = [...docEl.querySelectorAll('.row')].map((r) => ({
    start: Number(r.dataset.start),
    end: Number(r.dataset.end),
    top: r.getBoundingClientRect().top,
  }));
  const railTop = anchoredEl.getBoundingClientRect().top;
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
  anchoredEl.style.height = `${cursor}px`;
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
  if (state.history) return; // 履歴は読み取り専用。当時の本文にいま指摘を足せてしまうと再現性が壊れる
  const lo = Math.min(sel.start, sel.end);
  const hi = Math.max(sel.start, sel.end);
  draft = { startLine: lo, endLine: hi, text: draft?.text ?? '' };
  // 本文には触らない。下書きを開くのはレールの中の出来事
  renderRail();
  layoutRail();
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

/**
 * 再描画はレールを丸ごと作り直すので、下書きの textarea は別の要素に置き換わる。
 * 本文だけ引き継いでもフォーカスとキャレットが飛ぶと、打っている最中に手が止まる。
 * doc payload は他クライアントの投稿や resolve でも飛ぶため、自分の操作と無関係に起きる。
 */
function captureFocus() {
  const ta = railEl.querySelector('.bubble.draft textarea');
  if (!ta || document.activeElement !== ta) return null;
  return { start: ta.selectionStart, end: ta.selectionEnd };
}

function restoreFocus(saved) {
  if (!saved) return;
  const ta = railEl.querySelector('.bubble.draft textarea');
  if (!ta) return;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(saved.start, saved.end);
}

function render() {
  const { doc, comments } = state;
  if (!doc) return;
  const focus = captureFocus();
  filePathEl.textContent = doc.path;
  renderRoundControls();
  updateCount();

  renderDoc();
  paintSelection();
  renderRail();
  if (active) setActive(active);
  else layoutRail();
  restoreFocus(focus);
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

/* ===== ラウンドの切り替え (履歴) ===== */

/**
 * 過去ラウンドを表示する。当時の本文と当時のコメントをそのまま出す。
 * 本文と行アンカーは凍結済みなので、この間はコメントを打てない。
 */
async function showRound(n, focusId) {
  try {
    const res = await fetch(`/api/doc?round=${n}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    draft = null;
    sel = null;
    focusLine = null;
    active = focusId ?? null;
    applyPayload(payload);
    if (focusId) setActive(focusId, 'doc');
  } catch (err) {
    historyTextEl.textContent = `ラウンドを開けませんでした (${err.message})`;
    historyBarEl.hidden = false;
  }
}

async function showCurrent() {
  const res = await fetch('/api/doc');
  if (!res.ok) return;
  active = null;
  applyPayload(await res.json());
}

backBtn.addEventListener('click', () => showCurrent());
roundPickEl.addEventListener('change', () => {
  const n = Number(roundPickEl.value);
  if (n === state.round?.n) showCurrent();
  else showRound(n);
});

function renderRoundControls() {
  const round = state.round;
  if (!round) return;
  const viewing = round.viewing ?? round.n;
  roundEl.textContent = `R${String(viewing).padStart(3, '0')}`;

  const rounds = round.all ?? [];
  const want = rounds.map((r) => r.n).join(',');
  if (roundPickEl.dataset.rounds !== want) {
    roundPickEl.textContent = '';
    for (const r of rounds) {
      const o = el('option', null, `R${String(r.n).padStart(3, '0')}${r.n === round.n ? ' (現在)' : ''}`);
      o.value = String(r.n);
      roundPickEl.append(o);
    }
    roundPickEl.dataset.rounds = want;
  }
  roundPickEl.value = String(viewing);
  roundPickEl.hidden = rounds.length < 2;

  document.body.classList.toggle('viewing-history', state.history);
  historyBarEl.hidden = !state.history;
  if (state.history) {
    historyTextEl.textContent = `R${String(viewing).padStart(3, '0')} の当時の本文を見ています (読み取り専用)`;
  }
}

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

function applyPayload(payload) {
  const y = window.scrollY;
  state = {
    doc: payload.doc,
    comments: payload.comments,
    round: payload.round,
    carried: payload.carried ?? [],
    history: !!payload.history,
  };
  render();
  renderBanner(state.history ? null : payload.changed);
  window.scrollTo(0, y);
}

// 初回表示はここで 1 回だけ本文を取る。以降、本文の DOM を作り直すのは
// ラウンドを切った時と履歴に切り替えた時だけ (どちらも人の操作)。
async function boot() {
  const res = await fetch('/api/doc');
  if (!res.ok) return;
  applyPayload(await res.json());
}

/**
 * SSE で受けるのは通知だけ。ここで画面を作り直すと、読んでいる位置・入力中のフォーカス・
 * IME の変換・本文の選択が、人の操作と無関係に壊れる。
 */
const sse = new EventSource('/events');
sse.onmessage = (e) => {
  const payload = JSON.parse(e.data);
  if (payload.type !== 'changed') return;
  if (!state.history) renderBanner(payload);
};

boot();
