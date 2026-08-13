import * as v from 'valibot';
import {
  ChangedEventSchema,
  CommentsPayloadSchema,
  DocPayloadSchema,
  type Block,
  type ChangedState,
  type Comment,
  type CommentsPayload,
  type Doc,
  type DocPayload,
  type RoundComment,
  type RoundState,
} from '@akapen/shared';
import { bindKeys, loadKeymap } from './keys.ts';

/** Elements index.html is expected to have. Missing one fails at startup so it is noticed. */
function must<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`akapen: #${id} is missing from index.html`);
  return found as T;
}

const docEl = must('doc');
const railEl = must('rail');
const anchoredEl = must('railAnchored');
const carriedEl = must('railCarried');
const roundPickEl = must<HTMLSelectElement>('roundPick');
const historyBarEl = must('historyBar');
const historyTextEl = must('historyText');
const backBtn = must<HTMLButtonElement>('backToCurrent');
const railCloseEl = must<HTMLButtonElement>('railClose');
const filePathEl = must('filePath');
const countEl = must('count');
const roundEl = must('round');
const bannerEl = must('banner');
const bannerTextEl = must('bannerText');
const nextRoundBtn = must<HTMLButtonElement>('nextRound');
const showLines = must<HTMLInputElement>('showLines');

/** A comment being written: its range and text, kept alive across re-renders. */
type Draft = { startLine: number; endLine: number; text: string };
/** A selected range of lines. */
type Range = { start: number; end: number };
/** mermaid is loaded on demand from its own entry. We only initialise and run it. */
type MermaidLib = {
  initialize: (o: { startOnLoad: boolean; theme: string }) => void;
  run: (o: { nodes: ArrayLike<Element> }) => Promise<void>;
};

type State = {
  doc: Doc | null;
  comments: Comment[];
  /** `viewing` is the round on screen. While it differs from the current one, everything is read-only. */
  round: RoundState | null;
  carried: RoundComment[];
  history: boolean;
};

let state: State = { doc: null, comments: [], round: null, carried: [], history: false };
let drag: Range | null = null; // set only while dragging in the gutter
// The selection. Mouse and keyboard both end up moving this and calling startDraft.
// Without a single path you immediately grow "the mouse can select a range, the keyboard cannot".
let sel: Range | null = null;
let focusLine: number | null = null; // the line the keyboard is on (its first line number)
let draft: Draft | null = null;
let active: string | null = null; // the selected bubble (a comment id, or 'draft')
let mermaidLib: MermaidLib | null = null;

/** dataset holds strings only. Reading and writing line numbers goes through here. */
function setLine(node: HTMLElement, key: string, value: number): void {
  node.dataset[key] = String(value);
}

function getLine(node: Element, key: string): number {
  return Number((node as HTMLElement).dataset[key]);
}

/** An event target arrives as EventTarget. Return it only when it is an element. */
function targetEl(e: Event): HTMLElement | null {
  return e.target instanceof HTMLElement ? e.target : null;
}

/** Errors arrive as unknown. Only the message is fit to show. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read a body against the contract instead of asserting it.
 *
 * A cast holds only at compile time, and this is the one place where compile time
 * says nothing: akapen is left open while the file is edited, so a tab can outlive
 * the server it was built against. Checking here turns a shape mismatch into the
 * failure message the surrounding code already knows how to show, instead of an
 * undefined surfacing halfway through a render.
 *
 * The HTTP status stays with the caller — each one already decides what a failed
 * request means for its own bit of the screen.
 */
async function decode<S extends v.GenericSchema>(res: Response, schema: S): Promise<v.InferOutput<S>> {
  return v.parse(schema, await res.json());
}

nextRoundBtn.addEventListener('click', async () => {
  nextRoundBtn.disabled = true;
  try {
    const res = await fetch('/api/rounds', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await decode(res, DocPayloadSchema);
    // A new round means a new document, so swapping it wholesale is fine — a person asked for it
    draft = null;
    sel = null;
    focusLine = null;
    active = null;
    applyPayload(payload);
  } catch (err) {
    bannerTextEl.textContent = `could not close the round (${messageOf(err)})`;
  } finally {
    nextRoundBtn.disabled = false;
  }
});

/** Update after only comments changed. The document is left alone. */
function applyComments(payload: CommentsPayload) {
  state = {
    ...state,
    comments: payload.comments ?? state.comments,
    carried: payload.carried ?? state.carried,
  };
  markCommentedRows();
  renderRail();
  layoutRail();
  updateCount();
}

// A live change never swaps the document. Show how often it changed; the person decides whether to move on.
function renderBanner(changed: ChangedState | null | undefined) {
  if (!changed || !changed.dirty) {
    bannerEl.hidden = true;
    return;
  }
  const n = changed.changes;
  bannerTextEl.textContent = n > 1 ? `⟳ the document changed ${n} times` : '⟳ the document changed';
  bannerEl.hidden = false;
}

showLines.addEventListener('change', () => {
  document.body.classList.toggle('show-lines', showLines.checked);
});

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  html?: string | null,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function escapeHtml(s: string): string {
  const table: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return s.replace(/[&<>"]/g, (m) => table[m] ?? m);
}

// Logging a failure to the console only makes it look, to the person who clicked, like nothing happened
function fail(box: HTMLElement, message: string) {
  box.querySelector('.bubble-error')?.remove();
  box.append(el('div', 'bubble-error', escapeHtml(message)));
  layoutRail();
}

function overlaps(block: Block, startLine: number, endLine: number): boolean {
  return block.startLine <= endLine && block.endLine >= startLine;
}

/* ===== Document ===== */

function renderDoc() {
  const { doc, comments } = state;
  if (!doc) return;
  const fmLines = doc.blocks.filter((b) => b.kind === 'frontmatter');
  const fmFirst = fmLines[0]?.startLine;
  const fmLast = fmLines[fmLines.length - 1]?.startLine;

  docEl.textContent = '';
  for (const block of doc.blocks) {
    const cls = ['row', block.kind, ...block.flags];
    if (block.quoted) cls.push('quoted');
    if (block.startLine === fmFirst) cls.push('fm-first');
    if (block.startLine === fmLast) cls.push('fm-last');
    // A range comment spans several lines, so mark every overlapping line as an anchor
    const mine = comments.filter((c) => overlaps(block, c.startLine, c.endLine));
    if (mine.length) cls.push('has-comment');

    const row = el('div', cls.join(' '));
    setLine(row, 'start', block.startLine);
    setLine(row, 'end', block.endLine);
    // Move DOM focus with j/k too. -1 keeps a hundred-odd rows out of the tab order;
    // rows that carry a comment get 0 below so Tab can still reach them.
    row.tabIndex = -1;

    const gutter = el('div', 'gutter');
    gutter.append(el('span', 'lineno', String(block.startLine)));
    // While the rail is collapsed this marker is the only clue left
    if (mine.length) gutter.append(makeMarker(mine));
    const add = el('button', 'add', '+');
    add.title = `comment on lines ${block.startLine}-${block.endLine}`;
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
      if (targetEl(e)?.classList.contains('marker')) return;
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
    // The document can jump to a bubble as well (the link works both ways)
    row.addEventListener('click', (e) => {
      if (targetEl(e)?.closest('a, button')) return;
      // A click feeds the same path as j/k. Without this, picking a row and pressing c
      // still comments on the first line — mouse and keyboard drift apart.
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

/** Repaint only the per-row marks for comments. The document DOM is not rebuilt. */
function markCommentedRows() {
  for (const row of docEl.querySelectorAll<HTMLElement>('.row')) {
    const s = getLine(row, 'start');
    const e = getLine(row, 'end');
    const mine = state.comments.filter((c) => s <= c.endLine && e >= c.startLine);
    row.classList.toggle('has-comment', mine.length > 0);
    const gutter = row.querySelector<HTMLElement>('.gutter');
    if (!gutter) continue;
    const marker = gutter.querySelector<HTMLButtonElement>('.marker');
    if (!mine.length) {
      marker?.remove();
    } else if (marker) {
      marker.textContent = String(mine.length);
      marker.title = `${mine.length} comments`;
    } else {
      gutter.insertBefore(makeMarker(mine), gutter.querySelector('.add'));
    }
  }
}

function updateCount() {
  const open = state.comments.filter((c) => !c.resolved).length;
  const carried = state.carried.length;
  countEl.textContent = `${open} open / ${state.comments.length}${carried ? ` (+ ${carried} earlier)` : ''}`;
}

function makeMarker(mine: Comment[]): HTMLButtonElement {
  const marker = el('button', 'marker', String(mine.length));
  marker.title = `${mine.length} comments`;
  marker.addEventListener('click', (e) => {
    e.stopPropagation();
    openRail();
    // Look the comment up again on click: rows are not rebuilt, so a captured array goes stale
    const row = marker.closest('.row');
    if (!row) return;
    const s = getLine(row, 'start');
    const e2 = getLine(row, 'end');
    const now = state.comments.find((c) => s <= c.endLine && e2 >= c.startLine);
    if (now) setActive(now.id, 'rail');
  });
  return marker;
}

function rowFor(line: number): HTMLElement | null {
  const rows = [...docEl.querySelectorAll<HTMLElement>('.row')];
  return (
    rows.find((r) => getLine(r, 'start') <= line && line <= getLine(r, 'end')) ??
    rows.find((r) => getLine(r, 'start') >= line) ??
    rows.at(-1) ??
    null
  );
}

/* ===== Right rail ===== */

function rangeLabel(startLine: number, endLine: number): string {
  return `L${startLine}${endLine !== startLine ? `-${endLine}` : ''}`;
}

/** Keep a click inside the reply form from reaching the bubble, which navigates. */
function stopClick(e: Event): void {
  e.stopPropagation();
}

/**
 * The thread under a comment: the replies, then a box to add one.
 *
 * One level. A reply cannot be replied to, so this is a list and not a tree — the
 * exchange it carries is a person and an agent on one point, which does not branch.
 *
 * Replying is offered on a carried comment too. What a closed round freezes is the
 * document and its line anchors, and "this could not be fixed, and here is why" is
 * about work already handed over — the case that matters most.
 */
function repliesFor(c: Comment | RoundComment, past: boolean): HTMLElement {
  const wrap = el('div', 'replies');
  for (const r of c.replies ?? []) {
    const item = el('div', `reply${r.authorKind === 'agent' ? ' from-agent' : ''}`);
    const who = el('span', 'who', `@${escapeHtml(r.author)}`);
    // Named, not just styled: colour alone would not survive a custom.css that drops it,
    // and telling a person from an agent is the point once #12 lands.
    if (r.authorKind === 'agent') who.append(el('span', 'kind', 'agent'));
    item.append(who, el('div', 'reply-body', escapeHtml(r.body)));
    wrap.append(item);
  }

  const form = el('div', 'reply-form');
  const ta = el('textarea', 'reply-input');
  ta.rows = 1;
  ta.placeholder = 'reply';
  const send = el('button', 'reply-send', 'Reply');
  send.disabled = true;

  const sync = () => {
    send.disabled = ta.value.trim() === '';
    // The bubble just changed height, so everything below it has to move.
    layoutRail();
  };
  ta.addEventListener('input', sync);
  // Clicking into the box must not count as clicking the bubble, which navigates.
  ta.addEventListener('click', stopClick);
  form.addEventListener('click', stopClick);

  const submit = async () => {
    const body = ta.value.trim();
    if (!body || send.disabled) return;
    send.disabled = true;
    try {
      const res = await fetch(`/api/comments/${c.id}/replies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await decode(res, CommentsPayloadSchema);
      ta.value = '';
      // The response always carries the *current* round's comments, whichever round the
      // parent was in. Two cases cannot use them: a carried bubble, whose parent is in
      // an earlier round, and the history view, whose bubbles are that round's own. In
      // the second, applying them would not merely fail to show the reply — it would
      // swap the round on screen for the current one. Re-open the round instead.
      if ((past || state.history) && state.round?.viewing) void showRound(state.round.viewing, c.id);
      else applyComments(payload);
    } catch (err) {
      // Keep what was typed. Losing it leaves no way to get the words back.
      send.disabled = false;
      fail(form, `reply failed (${messageOf(err)})`);
    }
  };
  send.addEventListener('click', (e) => {
    e.stopPropagation();
    void submit();
  });
  ta.addEventListener('keydown', (e) => {
    // Same send key as a comment. Enter alone has to stay a newline.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  });

  form.append(ta, send);
  wrap.append(form);
  return wrap;
}

function bubbleFor(c: Comment, opts?: { past?: false }): HTMLElement;
function bubbleFor(c: RoundComment, opts: { past: true }): HTMLElement;
function bubbleFor(c: Comment | RoundComment, opts: { past?: boolean } = {}): HTMLElement {
  const box = el('div', `bubble${c.resolved ? ' resolved' : ''}${opts.past ? ' past' : ''}`);
  box.dataset['id'] = c.id;
  setLine(box, 'line', c.startLine);

  const head = el('div', 'bubble-head');
  head.append(el('span', 'who', `@${escapeHtml(c.author)}`));
  if (opts.past) {
    // Carry which round and which line this is about. Clicking jumps to the document as it was
    const round = (c as RoundComment).round;
    const tag = el('button', 'round-tag', `R${String(round).padStart(3, '0')}`);
    tag.title = `view the document at R${String(round).padStart(3, '0')}`;
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      void showRound(round, c.id);
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
      if (!state.history) applyComments(await decode(res, CommentsPayloadSchema));
      else if (state.round?.viewing) void showRound(state.round.viewing);
    } catch (err) {
      btn.disabled = false;
      fail(box, `update failed (${messageOf(err)})`);
    }
  });
  head.append(btn);

  box.append(head, el('div', 'bubble-body', escapeHtml(c.body)));
  box.append(repliesFor(c, opts.past === true));
  // If only a mouse can expand the collapsed body, the keyboard cannot read past 12em
  box.tabIndex = 0;
  box.addEventListener('click', () => {
    if (opts.past) void showRound((c as RoundComment).round, c.id);
    else setActive(c.id, 'doc');
  });
  box.addEventListener('focus', () => setActive(c.id));
  return box;
}

function draftBubble(): HTMLElement {
  if (!draft) throw new Error('akapen: draftBubble called with no draft');
  const { startLine, endLine, text } = draft;
  const box = el('div', 'bubble draft');
  box.dataset['id'] = 'draft';
  setLine(box, 'line', startLine);
  // send() closes over the range it was built with, so reuse must compare the end line
  // too. Checking only the start line posts the old range after the selection grows.
  setLine(box, 'end', endLine);

  const head = el('div', 'bubble-head');
  head.append(el('span', 'at', rangeLabel(startLine, endLine)));
  const spacer = el('span', null, '');
  spacer.style.flex = '1';
  head.append(spacer);
  box.append(head);

  const ta = el('textarea');
  ta.setAttribute('aria-label', `comment on ${rangeLabel(startLine, endLine)}`);
  ta.placeholder = 'say what is wrong here…  (Ctrl+Enter to send)';
  ta.value = text;
  ta.addEventListener('input', () => {
    if (draft) draft.text = ta.value;
    layoutRail(); // typing changes the height, so push the bubbles below back down
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
    if (submit.disabled) return; // hammering Ctrl+Enter must not post twice
    submit.disabled = true;
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startLine, endLine, body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      posted = await decode(res, CommentsPayloadSchema);
    } catch (err) {
      // Keep the draft. Discarding it leaves no way to get the typed text back
      submit.disabled = false;
      fail(box, `sending failed (${messageOf(err)})`);
      return;
    }
    draft = null;
    active = null;
    // Collapse the selection but keep the line focus: jumping around ruins writing several in a row
    sel = null;
    paintSelection();
    applyComments(posted);
  };
  cancel.addEventListener('click', close);
  submit.addEventListener('click', send);
  // Ctrl+Enter and Escape are not handled here. keys.ts' comment.submit and
  // comment.cancel click the buttons below. Holding them in two places lets one of
  // them skip the IME guard — which is exactly what happened.
  return box;
}

/**
 * The draft bubble is never rebuilt; it stays in the DOM.
 *
 * A textarea in the middle of an IME composition loses that composition the moment it
 * leaves the DOM — detaching and reattaching counts, so we simply do not touch it.
 * Focus and caret position survive for free as a result.
 */
function renderRail() {
  for (const b of anchoredEl.querySelectorAll('.bubble:not(.draft)')) b.remove();

  const existing = anchoredEl.querySelector<HTMLElement>('.bubble.draft');
  if (!draft) {
    existing?.remove();
  } else if (
    !existing ||
    (existing as HTMLElement).dataset['line'] !== String(draft.startLine) ||
    (existing as HTMLElement).dataset['end'] !== String(draft.endLine)
  ) {
    // Rebuild only when the range changed. No composition is in flight then, so removing it is safe
    existing?.remove();
    anchoredEl.append(draftBubble());
  }

  // Append in line order. Layout uses data-line so this does not affect drawing, but the
  // tab order follows DOM order, and without matching it the keyboard jumps around.
  for (const c of state.comments.toSorted((a, b) => a.startLine - b.startLine)) {
    anchoredEl.append(bubbleFor(c));
  }
  renderCarried();
}

/**
 * Unresolved comments from earlier rounds. They have no anchor in the current document,
 * so they cannot be aligned. They are shown anyway because with nothing carrying over,
 * "gone from the screen" would otherwise read as "dealt with".
 */
function renderCarried() {
  carriedEl.textContent = '';
  const carried = state.history ? [] : state.carried;
  if (!carried.length) {
    carriedEl.hidden = true;
    return;
  }
  carriedEl.hidden = false;
  const h = el('h2', null, `${carried.length} unresolved from earlier rounds`);
  carriedEl.append(h);
  for (const c of carried) carriedEl.append(bubbleFor(c, { past: true }));
}

/**
 * Line each bubble up with its anchor row. Overlaps push down; the document never moves.
 * Not inserting rows into the document is the whole point, so all the alignment is absorbed here.
 *
 * Reads (rect, offsetHeight) and writes (style.top) are kept apart. Interleaving them forces
 * a synchronous layout per bubble, and this function runs on every keystroke in the textarea —
 * on a long document that becomes visible.
 */
function layoutRail() {
  // DOM order cannot be trusted because the draft never moves. Sort by anchor line first;
  // out of order, "overlaps push down" means nothing.
  const bubbles = [...anchoredEl.querySelectorAll<HTMLElement>('.bubble')].toSorted(
    (a, b) => getLine(a, 'line') - getLine(b, 'line'),
  );
  if (!bubbles.length || document.body.classList.contains('rail-overlay')) {
    for (const b of bubbles) b.style.top = '';
    anchoredEl.style.height = '';
    return;
  }

  // --- read ---
  const rows = [...docEl.querySelectorAll<HTMLElement>('.row')].map((r) => ({
    start: getLine(r, 'start'),
    end: getLine(r, 'end'),
    top: r.getBoundingClientRect().top,
  }));
  const railTop = anchoredEl.getBoundingClientRect().top;
  const heights = bubbles.map((b) => b.offsetHeight);
  const gap =
    Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ak-bubble-gap'), 10) || 8;

  // --- compute --- both are in line order, so one moving pointer over the rows is enough
  const tops: number[] = [];
  let cursor = 0;
  let ri = 0;
  for (const [i, b] of bubbles.entries()) {
    const line = getLine(b, 'line');
    while (ri < rows.length - 1 && (rows[ri]?.end ?? 0) < line) ri++;
    const row = rows[ri];
    const want = row ? row.top - railTop : cursor;
    const top = Math.max(want, cursor);
    tops.push(top);
    cursor = top + (heights[i] ?? 0) + gap;
  }

  // --- write ---
  for (const [i, b] of bubbles.entries()) b.style.top = `${tops[i] ?? 0}px`;
  anchoredEl.style.height = `${cursor}px`;
}

function setActive(id: string, scroll?: 'doc' | 'rail') {
  active = id;
  for (const b of railEl.querySelectorAll<HTMLElement>('.bubble'))
    b.classList.toggle('active', (b as HTMLElement).dataset['id'] === id);
  const target = state.comments.find((c) => c.id === id) ?? (id === 'draft' ? draft : null);
  for (const row of docEl.querySelectorAll<HTMLElement>('.row')) {
    const s = getLine(row, 'start');
    const e = getLine(row, 'end');
    row.classList.toggle('linked', !!target && s <= target.endLine && e >= target.startLine);
  }
  // `active` un-collapses .bubble-body, so the height changes. Re-run the alignment
  layoutRail();
  if (!target) return;
  if (scroll === 'doc') rowFor(target.startLine)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (scroll === 'rail') {
    railEl
      .querySelector(`.bubble[data-id="${id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/* ===== Collapsed state (when there is not enough width) ===== */

// A collapsed rail only moves off-screen; it stays in the DOM. Forget to set inert and
// Tab walks into buttons nobody can see, and focus becomes impossible to locate.
function openRail() {
  if (!document.body.classList.contains('rail-overlay')) return;
  document.body.classList.add('rail-open');
  railEl.inert = false;
}
railCloseEl.addEventListener('click', () => {
  document.body.classList.remove('rail-open');
  railEl.inert = true;
});

// The same condition as @media (max-width: 1199px) in style.css. Written separately, a
// fractional width like 1199.5px makes CSS and JS disagree and every bubble stacks up.
const railOverlayQuery = window.matchMedia('(max-width: 1199px)');

function syncRailMode() {
  const overlay = railOverlayQuery.matches;
  document.body.classList.toggle('rail-overlay', overlay);
  if (!overlay) document.body.classList.remove('rail-open');
  railEl.inert = overlay && !document.body.classList.contains('rail-open');
}

/* ===== Selection and the form ===== */
/* Mouse and keyboard both move `sel` and call startDraft. One entry point. */

function paintSelection() {
  const lo = sel ? Math.min(sel.start, sel.end) : null;
  const hi = sel ? Math.max(sel.start, sel.end) : null;
  for (const row of docEl.querySelectorAll<HTMLElement>('.row')) {
    const s = getLine(row, 'start');
    row.classList.toggle('in-range', lo !== null && hi !== null && s >= lo && s <= hi);
    row.classList.toggle('focused', s === focusLine);
  }
}

function clearSelection() {
  sel = null;
  paintSelection();
}

function startDraft(): void {
  if (!sel) return;
  if (state.history) return; // history is read-only: adding feedback to a past document breaks reproducibility
  const lo = Math.min(sel.start, sel.end);
  const hi = Math.max(sel.start, sel.end);
  draft = { startLine: lo, endLine: hi, text: draft?.text ?? '' };
  // The document is untouched. Opening a draft happens inside the rail
  renderRail();
  layoutRail();
  openRail();
  setActive('draft');
  railEl.querySelector<HTMLTextAreaElement>('.bubble.draft textarea')?.focus();
}

document.addEventListener('mouseup', () => {
  if (!drag) return;
  drag = null;
  startDraft();
});

/* ===== Line focus (the keyboard path) ===== */

function lineNumbers() {
  return [...docEl.querySelectorAll('.row')].map((r) => getLine(r, 'start'));
}

/** Move `step` rows. With `extend`, grow the selection; otherwise collapse it to one line. */
function moveFocus(step: number, extend: boolean) {
  const lines = lineNumbers();
  if (!lines.length) return;
  const first = lines[0];
  if (first === undefined) return;
  if (focusLine === null) {
    focusLine = first;
  } else {
    const i = lines.indexOf(focusLine);
    const next = i < 0 ? 0 : Math.min(Math.max(i + step, 0), lines.length - 1);
    focusLine = lines[next] ?? first;
  }
  const anchor = extend && sel ? sel.start : focusLine;
  sel = { start: anchor, end: focusLine };
  paintSelection();
  const row = docEl.querySelector<HTMLElement>(`.row[data-start="${focusLine}"]`);
  row?.scrollIntoView({ block: 'nearest' });
  row?.focus({ preventScroll: true });
}

/* ===== Rendering ===== */

/**
 * A re-render rebuilds the rail, so the draft textarea becomes a different element.
 * Carrying the text alone is not enough: losing focus and the caret stops you mid-sentence.
 * A doc payload also arrives when another client posts or resolves, so this happens with
 * nothing to do with what you did.
 */
function captureFocus(): { start: number; end: number } | null {
  const ta = railEl.querySelector<HTMLTextAreaElement>('.bubble.draft textarea');
  if (!ta || document.activeElement !== ta) return null;
  return { start: ta.selectionStart, end: ta.selectionEnd };
}

function restoreFocus(saved: { start: number; end: number } | null) {
  if (!saved) return;
  const ta = railEl.querySelector<HTMLTextAreaElement>('.bubble.draft textarea');
  if (!ta) return;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(saved.start, saved.end);
}

function render() {
  const { doc } = state;
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
    // Points at build output. With no diagram in the document it is never fetched.
    // The URL is assembled at runtime so the bundler does not resolve it.
    const url = '/mermaid.js';
    const mod = (await import(/* @vite-ignore */ url)) as { default: MermaidLib };
    mermaidLib = mod.default;
    mermaidLib.initialize({
      startOnLoad: false,
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
    });
  }
  await mermaidLib.run({ nodes });
  layoutRail(); // drawing a diagram changes the document height, so always realign
}

// Realign whenever the document height changes (images, fonts, wrapping width)
new ResizeObserver(() => layoutRail()).observe(docEl);
railOverlayQuery.addEventListener('change', () => {
  syncRailMode();
  layoutRail();
});
window.addEventListener('resize', () => layoutRail());

syncRailMode();

/* ===== Switching rounds (history) ===== */

/**
 * Show a past round: the document and comments exactly as they were.
 * The document and its line anchors are frozen, so no comments can be written here.
 */
async function showRound(n: number, focusId?: string) {
  try {
    const res = await fetch(`/api/doc?round=${n}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await decode(res, DocPayloadSchema);
    draft = null;
    sel = null;
    focusLine = null;
    active = focusId ?? null;
    applyPayload(payload);
    if (focusId) setActive(focusId, 'doc');
  } catch (err) {
    historyTextEl.textContent = `could not open the round (${messageOf(err)})`;
    historyBarEl.hidden = false;
  }
}

async function showCurrent() {
  try {
    const res = await fetch('/api/doc');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await decode(res, DocPayloadSchema);
    active = null;
    applyPayload(payload);
  } catch (err) {
    // Returning quietly would make the back button look dead. Keep what is on screen —
    // it is still the round the person was reading — and say why it did not move.
    historyTextEl.textContent = `could not leave history (${messageOf(err)})`;
    historyBarEl.hidden = false;
  }
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
  if (roundPickEl.dataset['rounds'] !== want) {
    roundPickEl.textContent = '';
    for (const r of rounds) {
      const o = el('option', null, `R${String(r.n).padStart(3, '0')}${r.n === round.n ? ' (current)' : ''}`);
      o.value = String(r.n);
      roundPickEl.append(o);
    }
    roundPickEl.dataset['rounds'] = want;
  }
  roundPickEl.value = String(viewing);
  roundPickEl.hidden = rounds.length < 2;

  document.body.classList.toggle('viewing-history', state.history);
  historyBarEl.hidden = !state.history;
  if (state.history) {
    historyTextEl.textContent = `viewing the document as it was at R${String(viewing).padStart(3, '0')} (read-only)`;
  }
}

/* ===== Keymap =====
 * The bindings live in web/keys.ts; this holds only the actions themselves.
 * They call the same functions the mouse path does (startDraft, setActive) so the
 * two never fork.
 */
/** Returning false leaves the browser default alone (keys.ts' contract). */
const ACTIONS: Record<string, () => boolean | void> = {
  'row.next': () => moveFocus(1, false),
  'row.prev': () => moveFocus(-1, false),
  'row.extendNext': () => moveFocus(1, true),
  'row.extendPrev': () => moveFocus(-1, true),
  'comment.start': () => {
    if (focusLine === null) moveFocus(0, false);
    if (!sel) return false;
    startDraft();
    return undefined;
  },
  'comment.submit': () => {
    const btn = railEl.querySelector<HTMLButtonElement>('.bubble.draft button.primary');
    if (!btn) return false; // outside an editor, do not get in the way
    btn.click();
    return undefined;
  },
  'comment.cancel': () => {
    const btn = railEl.querySelector<HTMLButtonElement>('.bubble.draft button:not(.primary)');
    if (btn) btn.click();
    else if (document.body.classList.contains('rail-open')) railCloseEl.click();
    else if (sel) clearSelection();
    else return false;
    return undefined;
  },
  'lines.toggle': () => {
    showLines.checked = !showLines.checked;
    showLines.dispatchEvent(new Event('change'));
  },
};

loadKeymap().then((keymap) => bindKeys(keymap, ACTIONS));

function applyPayload(payload: DocPayload) {
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

// The first render fetches the document once, here. After that the document DOM is
// rebuilt only when a round is cut or history is opened — both things a person did.
async function boot() {
  try {
    const res = await fetch('/api/doc');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyPayload(await decode(res, DocPayloadSchema));
  } catch (err) {
    // There is nothing on screen yet, so a silent return leaves a blank page with no
    // way to tell a slow load from a dead server.
    bannerTextEl.textContent = `could not load the document (${messageOf(err)})`;
    bannerEl.hidden = false;
  }
}

/**
 * SSE delivers notifications only. Rebuilding the screen here would destroy the reading
 * position, the focused input, an in-flight IME composition and the text selection —
 * none of it caused by anything the person did.
 */
const sse = new EventSource('/events');
sse.addEventListener('message', (e) => {
  // An event arrives outside any request, so a throw here has nobody to catch it.
  // A payload we cannot read is dropped: the next one, or the next /api/doc, recovers.
  // JSON.parse has to be inside the guard — it runs while building safeParse's argument,
  // so a non-JSON event would throw before any of the checking happens.
  let data: unknown;
  try {
    data = JSON.parse(e.data);
  } catch {
    return;
  }
  const parsed = v.safeParse(ChangedEventSchema, data);
  if (!parsed.success) return;
  if (!state.history) renderBanner(parsed.output);
});

boot();
