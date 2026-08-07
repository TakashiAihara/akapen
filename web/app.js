const docEl = document.getElementById('doc');
const filePathEl = document.getElementById('filePath');
const countEl = document.getElementById('count');
const showLines = document.getElementById('showLines');

let state = { doc: null, comments: [] };
let drag = null; // { start, end }
let mermaidLib = null;

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

function commentsFor(block) {
  return state.comments.filter((c) => c.startLine === block.startLine && c.endLine === block.endLine);
}

function render() {
  const { doc, comments } = state;
  if (!doc) return;
  filePathEl.textContent = doc.path;
  const open = comments.filter((c) => !c.resolved).length;
  countEl.textContent = `${open} open / ${comments.length}`;

  const fmLines = doc.blocks.filter((b) => b.kind === 'frontmatter');
  const fmFirst = fmLines[0]?.startLine;
  const fmLast = fmLines[fmLines.length - 1]?.startLine;

  docEl.textContent = '';
  for (const block of doc.blocks) {
    const cls = ['row', block.kind, ...block.flags];
    if (block.quoted) cls.push('quoted');
    if (block.startLine === fmFirst) cls.push('fm-first');
    if (block.startLine === fmLast) cls.push('fm-last');
    const mine = commentsFor(block);
    if (mine.length) cls.push('has-comment');

    const row = el('div', cls.join(' '));
    row.dataset.start = block.startLine;
    row.dataset.end = block.endLine;

    const gutter = el('div', 'gutter');
    gutter.append(el('span', 'lineno', String(block.startLine)));
    const add = el('button', 'add', '+');
    add.title = `${block.startLine}-${block.endLine} 行にコメント`;
    gutter.append(add);
    row.append(gutter, el('div', 'body', block.html));

    gutter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      drag = { start: block.startLine, end: block.endLine };
      paintRange();
    });
    row.addEventListener('mouseenter', () => {
      if (!drag) return;
      drag.end = block.endLine;
      paintRange();
    });

    docEl.append(row);

    for (const c of mine) docEl.append(threadEl(c));
  }

  // drifted なコメントは元の行が消えている。文書末にまとめて出し、無視できないようにする
  const drifted = comments.filter((c) => c.drifted);
  if (drifted.length) {
    const box = el('div', 'thread');
    box.append(el('div', 'thread-head', `<span class="badge">drifted</span> 原文が見つからないコメント ${drifted.length} 件`));
    for (const c of drifted) box.append(el('div', 'thread-body', `${escapeHtml(c.body)}\n<code>${escapeHtml(c.anchor.slice(0, 120))}</code>`));
    docEl.append(box);
  }

  renderMermaid();
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
}

function threadEl(c) {
  const box = el('div', `thread${c.resolved ? ' resolved' : ''}`);
  const head = el('div', 'thread-head');
  head.append(el('span', null, `@${escapeHtml(c.author)}`));
  head.append(el('span', null, `L${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ''}`));
  if (c.drifted) head.append(el('span', 'badge', 'drifted'));
  const spacer = el('span', null, '');
  spacer.style.flex = '1';
  head.append(spacer);
  const btn = el('button', null, c.resolved ? 'Reopen' : 'Resolve');
  btn.addEventListener('click', async () => {
    await fetch(`/api/comments/${c.id}/resolve`, { method: 'POST' });
  });
  head.append(btn);
  box.append(head, el('div', 'thread-body', escapeHtml(c.body)));
  return box;
}

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
  openForm(lo, hi);
});

function openForm(startLine, endLine) {
  docEl.querySelector('.form')?.remove();
  const anchorRow = [...docEl.querySelectorAll('.row')].reverse().find((r) => Number(r.dataset.start) <= endLine);
  const form = el('div', 'form');
  const ta = el('textarea');
  ta.placeholder = 'ここを指摘する…  (Ctrl+Enter で送信)';
  const actions = el('div', 'form-actions');
  actions.append(el('span', 'form-range', `L${startLine}${endLine !== startLine ? `-${endLine}` : ''}`));
  const cancel = el('button', null, 'Cancel');
  const submit = el('button', 'primary', 'Comment');
  actions.append(cancel, submit);
  form.append(ta, actions);
  anchorRow?.after(form);
  ta.focus();

  const close = () => {
    form.remove();
    for (const row of docEl.querySelectorAll('.row')) row.classList.remove('in-range');
  };
  cancel.addEventListener('click', close);
  const send = async () => {
    const body = ta.value.trim();
    if (!body) return close();
    await fetch('/api/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startLine, endLine, body }),
    });
    close();
  };
  submit.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
    if (e.key === 'Escape') close();
  });
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
}

const sse = new EventSource('/events');
sse.onmessage = (e) => {
  const payload = JSON.parse(e.data);
  const y = window.scrollY;
  state = { doc: payload.doc, comments: payload.comments };
  render();
  window.scrollTo(0, y);
};
