/**
 * Regressions, in a real browser.
 *
 * Every case here is behaviour that actually broke and was caught by a person or by
 * CodeRabbit. The storage-layer tests caught none of them, so these look at the DOM.
 */
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { AUTH, expect, test } from './fixtures.ts';

const A = { rail: '#railAnchored .bubble', draft: '#rail .bubble.draft', ta: '#rail .bubble.draft textarea' };

test.beforeEach(async ({ page, akapen }) => {
  await page.goto(akapen.url);
  await expect(page.locator('.row').first()).toBeVisible();
  // mermaid renders asynchronously and changes the document height. Measure once it settles.
  // The count comes first: `.last()` resolves to whichever svg exists at the time, so on
  // its own it is satisfied by the first one and the height can still be measured while
  // the second diagram is being drawn. The fixture has two.
  await expect(page.locator('#doc svg')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator('#doc svg').last()).toBeVisible();
});

/** Open a draft by clicking + in the gutter. */
async function openDraft(page: Page, rowIndex = 1) {
  const row = page.locator('.row').nth(rowIndex);
  await row.hover();
  await row.locator('.add').click();
  await expect(page.locator(A.ta)).toBeFocused();
}

/** Two comments on adjacent list items, so the second sits right under the first. */
async function twoAdjacent(
  request: APIRequestContext,
  url: string,
  bodies: [string, string],
  reply?: string,
): Promise<void> {
  for (const [i, body] of bodies.entries()) {
    const posted = await request.post(`${url}/api/comments`, {
      headers: AUTH,
      data: { startLine: 14 + i, endLine: 14 + i, body },
    });
    expect(posted.ok()).toBe(true);
    if (reply === undefined) continue;
    const { id } = ((await posted.json()) as { comment: { id: string } }).comment;
    await request.post(`${url}/api/comments/${id}/replies`, { headers: AUTH, data: { body: reply } });
  }
}

/** The first bubble ends above the second. Retried, since the second slides into place. */
async function expectClear(first: Locator, next: Locator) {
  await expect(async () => {
    const a = await first.boundingBox();
    const b = await next.boundingBox();
    expect(a && b && a.y + a.height <= b.y).toBe(true);
  }).toPass({ timeout: 1_000 });
}

const resolve = (b: Locator) => b.getByRole('button', { name: 'Resolve' });

/** A diagram drawn late lays the rail out again, which would hide an overlap. */
async function openSettled(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('#doc svg')).toHaveCount(2, { timeout: 15_000 });
}

async function post(page: Page, body: string) {
  await page.locator(A.ta).fill(body);
  await page.locator(`${A.draft} button.primary`).click();
  await expect(page.locator(A.draft)).toHaveCount(0);
}

test('never inserts rows into the document (height is the same with and without comments)', async ({
  page,
}) => {
  const before = await page.locator('#doc').boundingBox();
  await openDraft(page);
  await post(page, 'checking the height does not move');
  await expect(page.locator(A.rail)).toHaveCount(1);
  const after = await page.locator('#doc').boundingBox();
  expect(after!.height).toBe(before!.height);
});

test('aligns bubbles to their anchor row without overlapping', async ({ page }) => {
  for (const i of [1, 2, 3]) {
    await openDraft(page, i);
    await post(page, `Feedback on L${i}. Made a bit long so the push-down is visible.`);
  }
  const boxes = await page.locator(A.rail).evaluateAll((els) =>
    els.map((el) => {
      const line = Number((el as HTMLElement).dataset['line']);
      const row = document.querySelector(`.row[data-start="${line}"]`);
      return {
        top: el.getBoundingClientRect().top,
        bottom: el.getBoundingClientRect().bottom,
        rowTop: row!.getBoundingClientRect().top,
      };
    }),
  );
  expect(boxes.length).toBe(3);
  for (const [i, b] of boxes.entries()) {
    expect(b.top).toBeGreaterThanOrEqual(b.rowTop - 1); // never above its anchor row
    if (i > 0) expect(b.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom - 1); // never overlapping
  }
});

test('keeps the document DOM and the text selection through server-driven events', async ({
  page,
  request,
  akapen,
}) => {
  await page.evaluate(() => {
    document.querySelectorAll('.row').forEach((r, i) => ((r as HTMLElement).dataset['mark'] = `g${i}`));
    const body = document.querySelectorAll('.row .body')[3]!;
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  const selected = await page.evaluate(() => getSelection()!.toString());
  expect(selected.length).toBeGreaterThan(0);

  // Another client posting must not change this screen
  await request.post(`${akapen.url}/api/comments`, {
    headers: AUTH,
    data: { startLine: 9, endLine: 9, body: 'from another client' },
  });
  await page.waitForTimeout(700);

  const state = await page.evaluate(() => ({
    survived: document.querySelectorAll('.row[data-mark]').length,
    total: document.querySelectorAll('.row').length,
    selection: getSelection()!.toString(),
  }));
  expect(state.survived).toBe(state.total);
  expect(state.selection).toBe(selected);
});

test('never rebuilds the textarea when a doc payload lands mid-typing (it would cut the IME)', async ({
  page,
  request,
  akapen,
}) => {
  await openDraft(page);
  // A real composition is CJK, but nothing here reads the glyphs: the event below is
  // synthetic and the assertions are on element identity and value. Multi-byte handling
  // is covered where it belongs, by sweep over docs/, which never opens a browser.
  await page.locator(A.ta).fill('midway through composing');
  await page.evaluate((sel) => {
    const ta = document.querySelector(sel) as HTMLTextAreaElement;
    ta.dataset['mark'] = 'original';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  }, A.ta);

  await request.post(`${akapen.url}/api/comments`, {
    headers: AUTH,
    data: { startLine: 9, endLine: 9, body: 'from another client' },
  });
  await page.waitForTimeout(700);

  const ta = page.locator(A.ta);
  await expect(ta).toHaveAttribute('data-mark', 'original'); // still the same element
  await expect(ta).toBeFocused();
  await expect(ta).toHaveValue('midway through composing');
});

test('posts the grown range after a draft range is extended', async ({ page }) => {
  await page.locator('.row').nth(1).click();
  await page.keyboard.press('c');
  await expect(page.locator(`${A.draft} .at`)).toHaveText('L2');

  await page.locator(A.ta).blur();
  await page.keyboard.press('Shift+J');
  await page.keyboard.press('Shift+J');
  await page.keyboard.press('c');
  await expect(page.locator(`${A.draft} .at`)).toHaveText('L2-4');

  await post(page, 'a range comment');
  await expect(page.locator(`${A.rail} .at`)).toHaveText('L2-4');
});

test('writes a comment with the keyboard alone', async ({ page }) => {
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('c');
  await expect(page.locator(A.ta)).toBeFocused();
  // While typing, j/k become text and the line focus stays put
  await page.keyboard.type('jk from the keyboard');
  await expect(page.locator(A.ta)).toHaveValue('jk from the keyboard');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator(A.draft)).toHaveCount(0);
  await expect(page.locator(A.rail)).toHaveCount(1);
});

test('freezes the document until a round is cut, and keeps the feedback after', async ({ page, akapen }) => {
  await openDraft(page);
  await post(page, 'raised in R001');

  // Imitate an agent's edit: the document does not swap, only the banner appears
  akapen.append('\n## A section the agent added\n\nThe result of the fix.\n');
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#doc')).not.toContainText('A section the agent added');
  await expect(page.locator('#round')).toHaveText('R001');

  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#doc')).toContainText('A section the agent added');
  await expect(page.locator(A.rail)).toHaveCount(0); // nothing carries over
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1); // but it has not vanished
  await expect(page.locator('#count')).toContainText('1 earlier');
});

test('takes a comment on a screen another one moved past, and files it on that round', async ({
  page,
  akapen,
}) => {
  // A person reviews while an agent writes and rounds are cut elsewhere. A comment written
  // on a screen left behind is a review somebody already wrote, so it must go through.
  const other = await page.context().newPage();
  await other.goto(akapen.url);
  await expect(other.locator('.row').first()).toBeVisible();

  akapen.append('\n## added while both screens were open\n');
  await other.locator('#nextRound').click();
  await expect(other.locator('#round')).toHaveText('R002');

  // This screen is told, and nothing on it moves: the document, the reading position
  // and anything half-typed are all still the person's to decide about.
  await expect(page.locator('#movedBar')).toBeVisible();
  await expect(page.locator('#round')).toHaveText('R001');
  await expect(page.locator('#doc')).not.toContainText('added while both screens were open');

  await openDraft(page);
  await post(page, 'written against the old round');
  await expect(page.locator(A.rail)).toHaveCount(1);
  await expect(page.locator(A.rail)).toContainText('written against the old round');
  await expect(page.locator('#round')).toHaveText('R001'); // nothing on screen moved to take it

  // On the current round it is feedback from an earlier one, like any other.
  await page.locator('#loadCurrent').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#railCarried .bubble')).toContainText('written against the old round');
});

test('keeps its own rail when resolving or replying on a screen another one moved past', async ({
  page,
  akapen,
}) => {
  // #175: the answer to a resolve or a reply carries the current round's comments.
  await openDraft(page);
  await post(page, 'on the old round');
  await openDraft(page, 2);
  await post(page, 'also on the old round');
  await expect(page.locator(A.rail)).toHaveCount(2);

  const other = await page.context().newPage();
  await other.goto(akapen.url);
  await expect(other.locator('.row').first()).toBeVisible();
  akapen.append('\n## added while both screens were open\n');
  await other.locator('#nextRound').click();
  await expect(other.locator('#round')).toHaveText('R002');
  await expect(page.locator('#movedBar')).toBeVisible();

  // A reply: the thread grows, and the rail is still this round's two comments, not R002's.
  const first = page.locator(A.rail).filter({ hasText: 'on the old round' }).first();
  await first.hover();
  await first.locator('.reply-input').fill('answered on the old screen');
  await first.locator('.reply-send').click();
  await expect(first.locator('.reply-body')).toHaveText('answered on the old screen');
  await expect(page.locator(A.rail)).toHaveCount(2);
  await expect(page.locator('#railCarried .bubble')).toHaveCount(0);

  // A resolve: the one comment is marked, and the other is still there beside it.
  await page
    .locator(A.rail)
    .filter({ hasText: 'also on the old round' })
    .getByRole('button', { name: 'Resolve' })
    .click();
  await expect(
    page.locator(A.rail).filter({ hasText: 'also on the old round' }).getByRole('button', { name: 'Reopen' }),
  ).toBeVisible();
  await expect(page.locator(A.rail)).toHaveCount(2);
  await expect(page.locator('#railCarried .bubble')).toHaveCount(0);
  await expect(page.locator('#round')).toHaveText('R001');
});

test('takes a resolve on a carried comment on a screen another one moved past', async ({ page, akapen }) => {
  // The resolved comment is in neither of the answer's lists, so it has to come from the
  // answer's own `comment`. It leaves the carried rail, as on a screen that is current.
  await openDraft(page);
  await post(page, 'carried from R001');
  akapen.append('\n## second round\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);
  // One of R002's own, so taking the whole answer would be seen: on R003 it is carried,
  // and R002's own rail would empty.
  await openDraft(page, 2);
  await post(page, 'on R002');
  await expect(page.locator(A.rail)).toHaveCount(1);

  const other = await page.context().newPage();
  await other.goto(akapen.url);
  await expect(other.locator('.row').first()).toBeVisible();
  akapen.append('\n## third round\n');
  await other.locator('#nextRound').click();
  await expect(other.locator('#round')).toHaveText('R003');
  await expect(page.locator('#movedBar')).toBeVisible();

  await page
    .locator('#railCarried .bubble')
    .filter({ hasText: 'carried from R001' })
    .getByRole('button', { name: 'Resolve' })
    .click();
  await expect(page.locator('#railCarried .bubble')).toHaveCount(0);
  await expect(page.locator(A.rail)).toHaveCount(1);
  await expect(page.locator(A.rail)).toContainText('on R002');
  await expect(page.locator('#round')).toHaveText('R002');
});

test('keeps a draft when the screen moves to another round, and asks for the lines again', async ({
  page,
  akapen,
}) => {
  const other = await page.context().newPage();
  await other.goto(akapen.url);
  await expect(other.locator('.row').first()).toBeVisible();
  akapen.append('\n## added while both screens were open\n');
  await other.locator('#nextRound').click();
  await expect(page.locator('#movedBar')).toBeVisible();

  await openDraft(page);
  await page.locator(A.ta).fill('half written');

  // The text survives the swap; the range does not, because those line numbers were read
  // from a document that is no longer on screen.
  await page.locator('#loadCurrent').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator(A.ta)).toHaveValue('half written');
  await expect(page.locator(A.draft)).toContainText('pick the lines again');

  await openDraft(page, 2);
  await expect(page.locator(A.ta)).toHaveValue('half written');
  await page.locator(`${A.draft} button.primary`).click();
  await expect(page.locator(A.draft)).toHaveCount(0);
  await expect(page.locator(A.rail)).toHaveCount(1);
});

test('takes a comment while an earlier round is open in history', async ({ page, akapen }) => {
  akapen.append('\n## Added\n\nmore text.\n');
  await page.locator('#nextRound').click();
  await page.locator('#roundPick').selectOption('1');
  await expect(page.locator('#historyBar')).toBeVisible();

  await openDraft(page);
  await post(page, 'about R001, from history');
  await expect(page.locator(A.rail)).toContainText('about R001, from history');
  await expect(page.locator('#historyBar')).toBeVisible();
  await expect(page.locator('#round')).toHaveText('R001');

  await page.locator('#backToCurrent').click();
  await expect(page.locator('#railCarried .bubble')).toContainText('about R001, from history');
});

test('does not let a slow reply hide a round that moved while it was in flight', async ({ page, akapen }) => {
  // The stream and the replies are separate channels with no order between them. A
  // /api/doc answer that left before a newer round opened must not walk the number back
  // and quietly hide the notice, leaving a screen behind with nothing saying so.
  const other = await page.context().newPage();
  await other.goto(akapen.url);
  await expect(other.locator('.row').first()).toBeVisible();

  akapen.append('\n## R002\n');
  await other.locator('#nextRound').click();
  await expect(other.locator('#round')).toHaveText('R002');
  await expect(page.locator('#movedBar')).toBeVisible();

  // Hold this screen's *answer* open while a third round is cut on the other one. The
  // request has to go out now — delaying that would just fetch R003 and prove nothing.
  await page.route('**/api/doc*', async (route) => {
    const answer = await route.fetch();
    const body = await answer.text();
    await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({ response: answer, body });
  });
  await page.locator('#loadCurrent').click();
  await page.waitForTimeout(500); // long enough for that request to have been answered

  akapen.append('\n## R003\n');
  await other.locator('#nextRound').click();
  await expect(other.locator('#round')).toHaveText('R003');

  // The answer lands carrying R002, which is what this screen now shows — and the notice
  // has to stay, because the server is on R003 and comments from here are filed on R002.
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#movedBar')).toBeVisible();
  await expect(page.locator('#movedBar')).toContainText('R003');
});

test('shows raw HTML from the markdown as text instead of running it', async ({ page }) => {
  // Look after both rendering and mermaid's async run have finished
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { xssMarker?: string }).xssMarker)).toBeUndefined();

  // It must not be in the DOM as elements
  expect(await page.locator('#doc script').count()).toBe(0);
  expect(await page.locator('#doc img').count()).toBe(0);
  expect(await page.locator('#doc b').count()).toBe(0);

  // It must still be readable as text: this is what is under review
  await expect(page.locator('#doc')).toContainText("<script>window.xssMarker = 'executed';</script>");
  // Quoted from the fixture verbatim
  await expect(page.locator('#doc')).toContainText('<b>not actually bold</b>');
});

test('loads and renders mermaid only when a diagram is present', async ({ page, akapen }) => {
  // beforeEach already opened it once, so reopen to observe the fetch
  const fetched: string[] = [];
  page.on('response', (r) => fetched.push(new URL(r.url()).pathname));
  await page.goto(akapen.url);
  await expect(page.locator('#doc svg')).toHaveCount(2, { timeout: 15_000 });
  expect(fetched).toContain('/mermaid.js');
  expect(fetched).toContain('/app.js');

  // Both diagrams, one fenced ```mermaid and one ```Mermaid. A language name is
  // case-insensitive to anyone writing markdown, and the capitalised one used to come
  // out as an ordinary code block with nothing said about why.
  await expect(page.locator('#doc svg')).toHaveCount(2, { timeout: 15_000 });
});

test('replies to a comment, and keeps the thread on a comment carried past a round', async ({
  page,
  akapen,
}) => {
  await page.goto(akapen.url);
  await page.locator('.row').nth(2).hover();
  await page.locator('.row').nth(2).locator('.add').click();
  await page.locator('.bubble.draft textarea').fill('this reads stiffly');
  await page.locator('.bubble.draft textarea').press('Control+Enter');
  await expect(page.locator('.bubble').first()).toBeVisible();

  // The form only appears once the bubble is being read, or every bubble grows by one.
  const bubble = page.locator('.bubble').first();
  await bubble.hover();
  await bubble.locator('.reply-input').fill('reworded');
  await bubble.locator('.reply-send').click();
  await expect(bubble.locator('.reply-body')).toHaveText('reworded');

  // Cutting a round moves the comment to the carried rail. The thread has to come with
  // it — a reply that stays behind is feedback nobody can find again.
  akapen.append('\n## Added\n\nmore text.\n');
  await page.locator('#nextRound').click();
  const carried = page.locator('#railCarried .bubble').first();
  await expect(carried).toBeVisible();
  await expect(carried.locator('.reply-body')).toHaveText('reworded');

  // A closed round still takes replies. Hover, not
  // click: clicking a carried bubble opens that round's history, so a form that needed a
  // click to appear could never be reached with a mouse.
  await carried.hover();
  // Opened in place on hover, since it never becomes active.
  expect(await carried.locator('.bubble-body').evaluate((b) => getComputedStyle(b).maxHeight)).toBe('none');
  await carried.locator('.reply-input').fill('still open because X');
  await carried.locator('.reply-send').click();
  await expect(page.locator('#railCarried .bubble').first().locator('.reply-body')).toHaveCount(2);
});

test('takes the keyboard through each bubble forwards and back, never into a folded body (#246)', async ({
  page,
  akapen,
  request,
}) => {
  // Folded bodies and replies are scroll boxes, which the browser would make stops of their
  // own; landing there neither opened the bubble nor kept the focus in it once it opened.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long text`).join('\n');
  await twoAdjacent(request, akapen.url, [long, long], long);
  await openSettled(page, akapen.url);
  const [first, next] = [page.locator(A.rail).first(), page.locator(A.rail).nth(1)];

  await first.focus();
  await expect(first).toHaveClass(/\bactive\b/);
  for (const stop of [resolve(first), first.locator('.reply-input'), next]) {
    await page.keyboard.press('Tab');
    await expect(stop).toBeFocused();
  }
  await expect(next).toHaveClass(/\bactive\b/);

  // Back from the second: the first is folded again, its reply box hidden, so its Resolve
  // and then the bubble itself, which opens it.
  for (const stop of [resolve(first), first]) {
    await page.keyboard.press('Shift+Tab');
    await expect(stop).toBeFocused();
  }
  await expect(first).toHaveClass(/\bactive\b/);

  // From the Resolve of a bubble that is not active, on to its reply box.
  await resolve(next).focus();
  await expect(next).not.toHaveClass(/\bactive\b/);
  await page.keyboard.press('Tab');
  await expect(next.locator('.reply-input')).toBeFocused();
});

test('opens a long comment for a keyboard reader who tabs onto its bubble', async ({
  page,
  akapen,
  request,
}) => {
  // The keyboard's way in: focus on the bubble makes it active, which opens its body.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long comment`).join('\n');
  await twoAdjacent(request, akapen.url, [long, 'the next remark']);
  await openSettled(page, akapen.url);
  const bubble = page.locator(A.rail).first();
  await bubble.focus();
  await expect(bubble).toHaveClass(/\bactive\b/);
  const open = await bubble
    .locator('.bubble-body')
    .evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight }));
  expect(open.shown).toBe(open.full);
  // Forty lines taller, and the next one moved down for it rather than drawn over.
  await expectClear(bubble, page.locator(A.rail).nth(1));
});

test('moves the next bubble down when a reply box is made taller by hand (#246)', async ({
  page,
  akapen,
  request,
}) => {
  await twoAdjacent(request, akapen.url, ['a remark', 'the next remark']);
  await openSettled(page, akapen.url);
  const [first, next] = [page.locator(A.rail).first(), page.locator(A.rail).nth(1)];
  await first.click();
  await expect(first.locator('.reply-input')).toBeVisible();
  await expectClear(first, next);
  // What dragging the resize handle does: only the box's height changes, and no input runs.
  await first.locator('.reply-input').evaluate((ta) => {
    (ta as HTMLElement).style.height = '200px';
  });
  await expectClear(first, next);
});

test('keeps a bubble that shows its reply form on hover or focus clear of the next one (#246)', async ({
  page,
  akapen,
  request,
}) => {
  await twoAdjacent(request, akapen.url, ['remark on line 14', 'remark on line 15']);
  await openSettled(page, akapen.url);
  const [first, next] = [page.locator(A.rail).first(), page.locator(A.rail).nth(1)];

  // Hover shows the form on a bubble that is not active, so nothing else re-lays the rail.
  await first.hover();
  await expect(first.locator('.reply-form')).toBeVisible();
  await expect(first).not.toHaveClass(/\bactive\b/);
  await expectClear(first, next);

  // :focus-within does the same, from a button inside the bubble.
  await page.mouse.move(0, 0);
  await first.getByRole('button', { name: 'Resolve' }).focus();
  await expect(first.locator('.reply-form')).toBeVisible();
  await expect(first).not.toHaveClass(/\bactive\b/);
  await expectClear(first, next);
});

test('folds a long reply until its bubble is being read, the way a long comment is folded', async ({
  page,
  akapen,
  request,
}) => {
  const posted = await request.post(`${akapen.url}/api/comments`, {
    headers: AUTH,
    data: { startLine: 10, endLine: 10, body: 'short remark' },
  });
  expect(posted.ok()).toBe(true);
  const { id } = ((await posted.json()) as { comment: { id: string } }).comment;
  // Replies run about ten times longer than comments (#160); forty lines is well past 12em.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long answer`).join('\n');
  await request.post(`${akapen.url}/api/comments/${id}/replies`, { headers: AUTH, data: { body: long } });

  await page.goto(akapen.url);
  const reply = page.locator('.bubble').first().locator('.reply-body');
  await expect(reply).toHaveCount(1);
  const folded = await reply.evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight }));
  expect(folded.shown).toBeLessThan(folded.full);

  // Focus on the bubble makes it active, which opens its replies too.
  await page.locator('.bubble').first().focus();
  await expect(page.locator('.bubble').first()).toHaveClass(/\bactive\b/);
  const open = await reply.evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight }));
  expect(open.shown).toBe(open.full);

  // Answering it rebuilds the rail; the bubble being read stays open.
  const bubble = page.locator('.bubble').first();
  await bubble.locator('.reply-input').fill('a second reply');
  await bubble.locator('.reply-send').click();
  await expect(bubble.locator('.reply-body')).toHaveCount(2);
  const after = await reply.first().evaluate((el) => ({ shown: el.clientHeight, full: el.scrollHeight }));
  expect(after.shown).toBe(after.full);
});

test('replies from the history view without swapping the round on screen', async ({ page, akapen }) => {
  await page.goto(akapen.url);
  await page.locator('.row').nth(2).hover();
  await page.locator('.row').nth(2).locator('.add').click();
  await page.locator('.bubble.draft textarea').fill('about R001');
  await page.locator('.bubble.draft textarea').press('Control+Enter');
  await expect(page.locator('.bubble').first()).toBeVisible();

  akapen.append('\n## Added\n\nmore text.\n');
  await page.locator('#nextRound').click();
  await page.locator('#roundPick').selectOption('1');
  await expect(page.locator('#historyBar')).toBeVisible();

  // The reply response carries the *current* round's comments. Applying them here would
  // not merely miss the reply — it would replace R001 on screen with the current round.
  const bubble = page.locator('#railAnchored .bubble').first();
  await bubble.hover();
  await bubble.locator('.reply-input').fill('answered on the old round');
  await bubble.locator('.reply-send').click();

  await expect(page.locator('#railAnchored .bubble').first().locator('.reply-body')).toHaveText(
    'answered on the old round',
  );
  // Still R001.
  await expect(page.locator('#historyBar')).toBeVisible();
  await expect(page.locator('#round')).toHaveText('R001');
});

/**
 * Reaching the + is hover geometry, and hover geometry is only real in a browser.
 *
 * Two things used to break it (#89): the 8px flex gap between the gutter and the text
 * belonged to neither element, so the + went out on the way to it, and the gutter kept
 * the height of the + (18px) on rows that are far taller, so the lower half of a
 * heading did not reach it at all.
 */
function tallRow(page: Page) {
  // A heading: tall enough that an 18px gutter cannot cover it.
  return page
    .locator('.row')
    .filter({ has: page.locator('h1') })
    .first();
}

/** The opacity of a row's +, with the pointer parked at (x, y). */
async function addOpacityAt(page: Page, row: ReturnType<typeof tallRow>, x: number, y: number) {
  await page.mouse.move(x, y);
  return await row.locator('.add').evaluate((e) => getComputedStyle(e).opacity);
}

test('keeps + shown from the text to the gutter, over the whole height of a tall row', async ({ page }) => {
  const row = tallRow(page);
  const rowBox = (await row.boundingBox())!;
  const body = (await row.locator('.body').boundingBox())!;
  const addBox = (await row.locator('.add').boundingBox())!;

  // The row has to be taller than the + for the second half of this to mean anything
  expect(rowBox.height).toBeGreaterThan(addBox.height * 2);
  // The strip is pulled clear of the text and costs it no width: the text starts where the
  // row starts. Widening the gutter without paying it back in negative margin would push
  // every line right instead — the whole document moves and nothing else here would notice.
  const gutter = (await row.locator('.gutter').boundingBox())!;
  expect(body.x).toBeCloseTo(rowBox.x, 0);
  // It reaches the text and stops. Growing over it would take the first characters of every
  // line away from the pointer, which is worse than the gap this replaces.
  expect(gutter.x + gutter.width).toBeLessThanOrEqual(body.x);
  // The + is still drawn where it was: same 18px square, same 8px clear of the text,
  // top-aligned to the row. Widening the hit area must not move what is on screen.
  expect(addBox.width).toBe(18);
  expect(addBox.height).toBe(18);
  expect(body.x - (addBox.x + addBox.width)).toBeCloseTo(8, 0);
  expect(addBox.y).toBeCloseTo(rowBox.y, 0);

  const xs = [
    { at: body.x + 60, what: 'inside the text' },
    { at: body.x + 2, what: 'the left edge of the text' },
    { at: body.x - 2, what: 'the gap, against the text' }, // the dead zone
    { at: body.x - 6, what: 'the gap, against the gutter' }, // the dead zone
    { at: addBox.x + 2, what: 'on the + itself' },
  ];
  const ys = [
    { at: rowBox.y + 4, what: 'the top of the row' },
    { at: body.y + body.height - 2, what: 'the bottom of the row' },
  ];
  for (const y of ys) {
    for (const x of xs) {
      expect(await addOpacityAt(page, row, x.at, y.at), `${x.what}, at ${y.what}`).toBe('1');
    }
  }
});

test('opens a draft on the right line from anywhere in the widened strip', async ({ page }) => {
  const row = tallRow(page);
  const line = await row.getAttribute('data-start');
  const rowBox = (await row.boundingBox())!;
  const body = (await row.locator('.body').boundingBox())!;

  // The strip is live over its whole area, and it says so: a click there is a click on the
  // line, the same as pressing the +. The place picked is the one that used to be inert
  // twice over — the old dead gap, at the bottom of a row far taller than the +.
  const cursors = await row.evaluate((el) => ({
    gutter: getComputedStyle(el.querySelector('.gutter')!).cursor,
    add: getComputedStyle(el.querySelector('.add')!).cursor,
  }));
  expect(cursors.gutter).toBe('pointer');
  expect(cursors.add).toBe('pointer');

  // Prove the point clicked is the strip and not the text: a click that drifted onto the
  // body would be answered by the row, and this would read as the strip having worked.
  const gutter = (await row.locator('.gutter').boundingBox())!;
  const x = body.x - 4;
  expect(gutter.x).toBeLessThanOrEqual(x);
  expect(gutter.x + gutter.width).toBeGreaterThan(x);

  await page.mouse.click(x, rowBox.y + rowBox.height - 6);
  await expect(page.locator(A.ta)).toBeFocused();
  await expect(page.locator(`${A.draft} .at`)).toHaveText(`L${line}`);
});

test('leaves + hidden outside the row, so the wider gutter is not a hover trap', async ({ page }) => {
  const row = tallRow(page);
  const rowBox = (await row.boundingBox())!;
  const gutter = (await row.locator('.gutter').boundingBox())!;

  // The gutter may only take the strip the page already reserves for it (.stage pads the
  // text by 56px and the gutter is pulled 42px back into it). Measuring the strip from the
  // gutter itself would prove nothing: it would follow a gutter that grew off to the left.
  expect(rowBox.x - gutter.x).toBeLessThanOrEqual(42);
  const outside = rowBox.x - 48; // left of the reserved strip, in the page's own margin

  for (const y of [rowBox.y + 4, rowBox.y + rowBox.height - 4]) {
    expect(await addOpacityAt(page, row, outside, y), 'left of the reserved strip').toBe('0');
    expect(await addOpacityAt(page, row, rowBox.x + rowBox.width + 40, y), 'right of the row').toBe('0');
  }

  // Another row's gutter is another row's business: hovering it must leave this + alone
  const other = page
    .locator('.row')
    .filter({ has: page.locator('h2') })
    .first();
  const otherBox = (await other.boundingBox())!;
  expect(await addOpacityAt(page, row, gutter.x + 4, otherBox.y + 4), 'the gutter of another row').toBe('0');
  expect(await addOpacityAt(page, row, otherBox.x + 40, otherBox.y + 4), 'the text of another row').toBe('0');
});

test('marks a reply sent with a session as the agent, and names the session', async ({
  page,
  request,
  akapen,
}) => {
  const session = '00000000-0000-4000-8000-000000000000';
  const res = await request.post(`${akapen.url}/api/comments`, {
    headers: AUTH,
    data: { startLine: 10, endLine: 10, body: 'about this line' },
  });
  const { comment } = (await res.json()) as { comment: { id: string } };
  await request.post(`${akapen.url}/api/comments/${comment.id}/replies`, {
    headers: { ...AUTH, 'x-akapen-session': session },
    data: { body: 'fixed' },
  });

  await page.goto(akapen.url);
  const reply = page.locator('.reply').first();
  await expect(reply.locator('.kind')).toHaveText('agent');
  await expect(reply.locator('.session')).toHaveText(session.slice(0, 8));
  await expect(reply.locator('.session')).toHaveAttribute('title', session);
});

/** A write made from outside the page, as an agent or another tab would make it. */
async function writeElsewhere(
  request: APIRequestContext,
  url: string,
  path: string,
  data?: object,
  agent = false,
) {
  const res = await request.post(`${url}${path}`, {
    headers: agent ? { ...AUTH, 'x-akapen-session': '00000000-0000-4000-8000-000000000000' } : AUTH,
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { comment: { id: string } };
}

test('shows a reply written elsewhere without a reload', async ({ page, request, akapen }) => {
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'asked on the open page',
  });
  await openSettled(page, akapen.url);
  const bubble = page.locator(A.rail).filter({ hasText: 'asked on the open page' });
  await expect(bubble.locator('.reply')).toHaveCount(0);

  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${comment.id}/replies`,
    { body: 'answered from outside' },
    true,
  );
  await expect(bubble.locator('.reply-body')).toHaveText('answered from outside');
  await expect(bubble.locator('.reply .kind')).toHaveText('agent');
});

test('shows a comment and a resolve written elsewhere without a reload', async ({
  page,
  request,
  akapen,
}) => {
  await expect(page.locator(A.rail)).toHaveCount(0);
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'written in another tab',
  });
  const bubble = page.locator(A.rail).filter({ hasText: 'written in another tab' });
  await expect(bubble).toHaveCount(1);
  await expect(page.locator('#count')).toHaveText('1 open / 1');

  await writeElsewhere(request, akapen.url, `/api/comments/${comment.id}/resolve`);
  await expect(bubble).toHaveClass(/resolved/);
  await expect(page.locator('#count')).toHaveText('0 open / 1');
});

test('keeps a half-typed reply when another reply lands on the same thread', async ({
  page,
  request,
  akapen,
}) => {
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'thread with a reply box',
  });
  await openSettled(page, akapen.url);
  const bubble = page.locator(A.rail).filter({ hasText: 'thread with a reply box' });
  const box = bubble.locator('.reply-input');
  await bubble.hover();
  await box.fill('half of a reply');
  await box.evaluate((n) => n.setAttribute('data-same-node', 'yes'));

  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${comment.id}/replies`,
    { body: 'arrived meanwhile' },
    true,
  );
  await expect(bubble.locator('.reply-body')).toHaveText('arrived meanwhile');
  await expect(box).toHaveValue('half of a reply');
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute('data-same-node', 'yes');
});

test('keeps a half-typed comment when a comment is written elsewhere', async ({ page, request, akapen }) => {
  await openDraft(page);
  await page.locator(A.ta).fill('half of a comment');
  await page.locator(A.ta).evaluate((n) => n.setAttribute('data-same-node', 'yes'));

  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'arrived from outside',
  });
  await expect(page.locator(A.rail).filter({ hasText: 'arrived from outside' })).toHaveCount(1);
  await expect(page.locator(A.ta)).toHaveValue('half of a comment');
  await expect(page.locator(A.ta)).toBeFocused();
  await expect(page.locator(A.ta)).toHaveAttribute('data-same-node', 'yes');
});

test('keeps its own round on a screen another one moved past when a reply lands on it', async ({
  page,
  request,
  akapen,
}) => {
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'filed on the first round',
  });
  await openSettled(page, akapen.url);
  await expect(page.locator(A.rail)).toHaveCount(1);

  const other = await page.context().newPage();
  await other.goto(akapen.url);
  await expect(other.locator('.row').first()).toBeVisible();
  akapen.append('\n## cut while both screens were open\n');
  await other.locator('#nextRound').click();
  await expect(other.locator('#round')).toHaveText('R002');
  await expect(page.locator('#movedBar')).toBeVisible();

  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${comment.id}/replies`,
    { body: 'late reply from outside' },
    true,
  );
  const bubble = page.locator(A.rail).filter({ hasText: 'filed on the first round' });
  await expect(bubble.locator('.reply-body')).toHaveText('late reply from outside');
  await expect(page.locator(A.rail)).toHaveCount(1);
  await expect(page.locator('#railCarried .bubble')).toHaveCount(0);
  await expect(page.locator('#round')).toHaveText('R001');
});

test('keeps showing the round in history and picks up a reply written elsewhere', async ({
  page,
  request,
  akapen,
}) => {
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'said on the closed round',
  });
  await openSettled(page, akapen.url);
  akapen.append('\n## second round heading\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await page.locator('#roundPick').selectOption('1');
  await expect(page.locator('#round')).toHaveText('R001');
  const bubble = page.locator(A.rail).filter({ hasText: 'said on the closed round' });
  await expect(bubble).toHaveCount(1);

  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${comment.id}/replies`,
    { body: 'reply to a closed round' },
    true,
  );
  await expect(bubble.locator('.reply-body')).toHaveText('reply to a closed round');
  await expect(page.locator(A.rail)).toHaveCount(1);
  await expect(page.locator('#round')).toHaveText('R001');
});

test('folds a bubble that stops being active when the draft is cancelled', async ({
  page,
  request,
  akapen,
}) => {
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'to be selected',
  });
  await openSettled(page, akapen.url);
  const bubble = page.locator(A.rail).filter({ hasText: 'to be selected' });
  await openDraft(page);
  await bubble.click();
  await expect(bubble).toHaveClass(/active/);

  await page.locator(`${A.draft} button:not(.primary)`).click();
  await expect(page.locator(A.draft)).toHaveCount(0);
  await expect(bubble).not.toHaveClass(/active/);
});

test('drops a failed resolve message once a later resolve works', async ({ page, request, akapen }) => {
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'resolve twice',
  });
  await openSettled(page, akapen.url);
  let calls = 0;
  await page.route('**/api/comments/*/resolve', (route) =>
    ++calls === 1 ? route.fulfill({ status: 500, body: 'refused' }) : route.continue(),
  );
  const bubble = page.locator(A.rail).filter({ hasText: 'resolve twice' });
  await bubble.getByRole('button', { name: 'Resolve' }).click();
  await expect(bubble.locator('.bubble-error')).toHaveText('update failed (HTTP 500)');

  await bubble.getByRole('button', { name: 'Resolve' }).click();
  await expect(bubble).toHaveClass(/resolved/);
  await expect(bubble.locator('.bubble-error')).toHaveCount(0);
});

test('drops a failed reply message once a later reply works', async ({ page, request, akapen }) => {
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'reply twice',
  });
  await openSettled(page, akapen.url);
  let calls = 0;
  await page.route('**/api/comments/*/replies', (route) =>
    ++calls === 1 ? route.fulfill({ status: 500, body: 'refused' }) : route.continue(),
  );
  const bubble = page.locator(A.rail).filter({ hasText: 'reply twice' });
  await bubble.hover();
  await bubble.locator('.reply-input').fill('second try');
  await bubble.locator('.reply-send').click();
  await expect(bubble.locator('.bubble-error')).toHaveCount(1);
  await expect(bubble.locator('.bubble-error')).toContainText('reply failed');

  await bubble.locator('.reply-send').click();
  await expect(bubble.locator('.reply-body')).toHaveText('second try');
  await expect(bubble.locator('.bubble-error')).toHaveCount(0);
});

test('keeps a reply written elsewhere when the answer to your own reply arrives late', async ({
  page,
  request,
  akapen,
}) => {
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'two replies race',
  });
  await openSettled(page, akapen.url);
  let reached = false;
  const held = Promise.withResolvers<void>();
  const gate = held.promise;
  await page.route('**/api/comments/*/replies', async (route) => {
    const answer = await route.fetch();
    reached = true;
    await gate;
    await route.fulfill({ response: answer });
  });
  const bubble = page.locator(A.rail).filter({ hasText: 'two replies race' });
  await bubble.hover();
  await bubble.locator('.reply-input').fill('mine from the page');
  await bubble.locator('.reply-send').click();
  await expect.poll(() => reached).toBe(true);

  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${comment.id}/replies`,
    { body: 'theirs from outside' },
    true,
  );
  await expect(bubble.locator('.reply-body')).toHaveText(['mine from the page', 'theirs from outside']);
  held.resolve();
  // The box is emptied just before the late answer is applied; the rollback, if any, stays.
  await expect(bubble.locator('.reply-input')).toHaveValue('');
  await page.waitForTimeout(500);
  await expect(bubble.locator('.reply-body')).toHaveText(['mine from the page', 'theirs from outside']);
});

/**
 * A comment on R001 shown as carried on a screen that another one has since moved past.
 * The screen cut R002 itself and a second page cut R003.
 */
async function carriedOnBehindScreen(
  page: Page,
  request: APIRequestContext,
  akapen: { url: string; append: (text: string) => void },
  body: string,
): Promise<string> {
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body,
  });
  await openSettled(page, akapen.url);
  akapen.append('\n## second round\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);

  const other = await page.context().newPage();
  await other.goto(akapen.url);
  await expect(other.locator('.row').first()).toBeVisible();
  akapen.append('\n## third round\n');
  await other.locator('#nextRound').click();
  await expect(other.locator('#round')).toHaveText('R003');
  await expect(page.locator('#movedBar')).toBeVisible();
  return comment.id;
}

const REFRESH_GET = /\/api\/doc\?round=/;

test('goes on showing comments after a refresh that never got an answer', async ({
  page,
  request,
  akapen,
}) => {
  let requests = 0;
  await page.route(REFRESH_GET, async (route) => {
    if (++requests !== 1) return route.continue();
  });
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'asked for and never answered',
  });
  await expect.poll(() => requests).toBe(1);
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 15,
    endLine: 15,
    body: 'written during the silence',
  });
  // The page gives a refresh ten seconds before it asks again.
  await expect(page.locator(A.rail).filter({ hasText: 'written during the silence' })).toHaveCount(1, {
    timeout: 20_000,
  });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('shows a comment written while a refresh is in flight once that refresh has answered', async ({
  page,
  request,
  akapen,
}) => {
  const held = Promise.withResolvers<void>();
  let requests = 0;
  let answered = false;
  await page.route(REFRESH_GET, async (route) => {
    if (++requests !== 1) return route.continue();
    const answer = await route.fetch();
    answered = true;
    await held.promise;
    await route.fulfill({ response: answer });
  });
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'older write',
  });
  await expect.poll(() => answered).toBe(true);
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 15,
    endLine: 15,
    body: 'newer write',
  });
  await page.waitForTimeout(500);
  expect(requests).toBe(1);
  await expect(page.locator(A.rail).filter({ hasText: 'newer write' })).toHaveCount(0);

  held.resolve();
  await expect(page.locator(A.rail).filter({ hasText: 'newer write' })).toHaveCount(1);
  await expect(page.locator(A.rail)).toHaveCount(2);
});

test('does not put a held answer from another round on a screen that moved on', async ({
  page,
  request,
  akapen,
}) => {
  const held = Promise.withResolvers<void>();
  let calls = 0;
  let answered = false;
  await page.route(REFRESH_GET, async (route) => {
    if (++calls !== 1) return route.continue();
    const answer = await route.fetch();
    answered = true;
    await held.promise;
    await route.fulfill({ response: answer });
  });
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'written on the first round',
  });
  await expect.poll(() => answered).toBe(true);

  akapen.append('\n## second round\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);

  held.resolve();
  await page.waitForTimeout(500);
  await expect(page.locator(A.rail)).toHaveCount(0);
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);
});

test('drops a carried comment resolved elsewhere from a screen another one moved past', async ({
  page,
  request,
  akapen,
}) => {
  const id = await carriedOnBehindScreen(page, request, akapen, 'carried then resolved');
  await writeElsewhere(request, akapen.url, `/api/comments/${id}/resolve`);
  await expect(page.locator('#railCarried .bubble')).toHaveCount(0);
});

test('shows a reply written elsewhere on a carried comment of a screen another one moved past', async ({
  page,
  request,
  akapen,
}) => {
  const id = await carriedOnBehindScreen(page, request, akapen, 'carried then answered');
  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${id}/replies`,
    { body: 'answer to a carried one' },
    true,
  );
  await expect(page.locator('#railCarried .bubble .reply-body')).toHaveText('answer to a carried one');
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);
});

test('shows a comment written while the stream was down once it reconnects', async ({
  page,
  request,
  akapen,
}) => {
  // The browser reaches the server through a relay that this test can cut and bring back.
  // Going offline in the browser leaves a stream that is already open running.
  const target = new URL(akapen.url);
  const sockets = new Set<Socket>();
  const relay = () =>
    createServer((client) => {
      const upstream = connect(Number(target.port), '127.0.0.1');
      for (const s of [client, upstream]) {
        sockets.add(s);
        s.on('error', () => {});
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
  let server = relay();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const viewer = await page.context().newPage();
  try {
    await openSettled(viewer, `http://127.0.0.1:${port}${target.pathname}`);

    server.close();
    for (const s of sockets) s.destroy();
    await expect(viewer.locator('#otherDocBar')).toBeVisible();
    await writeElsewhere(request, akapen.url, '/api/comments', {
      startLine: 14,
      endLine: 14,
      body: 'written while the stream was down',
    });
    server = relay();
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    await expect(viewer.locator('#otherDocBar')).toBeHidden({ timeout: 15_000 });
    await expect(viewer.locator(A.rail).filter({ hasText: 'written while the stream was down' })).toHaveCount(
      1,
    );
  } finally {
    // Closing a relay that is already closed throws, which would hide why the test failed.
    if (server.listening) server.close();
    for (const s of sockets) s.destroy();
  }
});

test('keeps a comment written elsewhere when the answer to your own comment arrives late', async ({
  page,
  request,
  akapen,
}) => {
  const held = Promise.withResolvers<void>();
  let reached = false;
  await page.route('**/api/comments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const answer = await route.fetch();
    reached = true;
    await held.promise;
    await route.fulfill({ response: answer });
  });
  await openDraft(page);
  await page.locator(A.ta).fill('my own comment from the page');
  await page.locator(`${A.draft} button.primary`).click();
  await expect.poll(() => reached).toBe(true);

  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 15,
    endLine: 15,
    body: 'their comment from outside',
  });
  // The draft is still open and is a bubble of its own, so only the comments are counted.
  await expect(page.locator(`${A.rail}:not(.draft)`)).toHaveCount(2);
  held.resolve();
  await expect(page.locator(A.draft)).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.locator(A.rail)).toHaveCount(2);
  await expect(page.locator(A.rail).filter({ hasText: 'their comment from outside' })).toHaveCount(1);
});

test('leaves the head of a comment alone when another comment gets a reply', async ({
  page,
  request,
  akapen,
}) => {
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'untouched one',
  });
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 15,
    endLine: 15,
    body: 'answered one',
  });
  await openSettled(page, akapen.url);
  const untouched = page.locator(A.rail).filter({ hasText: 'untouched one' });
  await untouched
    .getByRole('button', { name: 'Resolve' })
    .evaluate((n) => n.setAttribute('data-same-node', 'yes'));

  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${comment.id}/replies`,
    { body: 'reply elsewhere' },
    true,
  );
  await expect(page.locator(A.rail).filter({ hasText: 'answered one' }).locator('.reply-body')).toHaveText(
    'reply elsewhere',
  );
  await expect(untouched.getByRole('button', { name: 'Resolve' })).toHaveAttribute('data-same-node', 'yes');
});

test('puts a comment written elsewhere above a later one in the rail order', async ({
  page,
  request,
  akapen,
}) => {
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 16,
    endLine: 16,
    body: 'on the later line',
  });
  await openSettled(page, akapen.url);
  await expect(page.locator(A.rail)).toHaveCount(1);
  const box = page.locator(A.rail).locator('.reply-input');
  await page.locator(A.rail).hover();
  await box.fill('typed under the later one');
  await box.evaluate((n) => n.setAttribute('data-same-node', 'yes'));

  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'on the earlier line',
  });
  await expect(page.locator(A.rail)).toHaveCount(2);
  const later = page.locator(A.rail).filter({ hasText: 'on the later line' }).locator('.reply-input');
  await expect(later).toHaveAttribute('data-same-node', 'yes');
  await expect(later).toHaveValue('typed under the later one');
  await expect(later).toBeFocused();
  await expect(page.locator(A.rail).first()).toContainText('on the earlier line');
  await expect(page.locator(A.rail).last()).toContainText('on the later line');
});

test('counts the carried comments left after one is resolved elsewhere', async ({
  page,
  request,
  akapen,
}) => {
  for (const [i, body] of ['carried alpha', 'carried beta'].entries()) {
    await writeElsewhere(request, akapen.url, '/api/comments', { startLine: 14 + i, endLine: 14 + i, body });
  }
  const alpha = await page.evaluate(async () => {
    const all = (await (await fetch('api/comments')).json()) as { id: string; body: string }[];
    return all.find((c) => c.body === 'carried alpha')?.id;
  });
  await openSettled(page, akapen.url);
  akapen.append('\n## second round\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#railCarried h2')).toHaveText('2 unresolved from earlier rounds');

  await writeElsewhere(request, akapen.url, `/api/comments/${alpha}/resolve`);
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);
  await expect(page.locator('#railCarried h2')).toHaveText('1 unresolved from earlier rounds');
});

test('opens a draft above the comments already in the rail order', async ({ page, request, akapen }) => {
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'already shown',
  });
  await openSettled(page, akapen.url);
  await expect(page.locator(A.rail)).toHaveCount(1);

  await openDraft(page);
  await expect(page.locator(A.rail)).toHaveCount(2);
  await expect(page.locator(A.rail).first()).toHaveClass(/draft/);
});

/** The screen is on R002 and a second page has cut R003, so the server is a round ahead of it. */
async function screenOneRoundBehind(
  page: Page,
  akapen: { url: string; append: (text: string) => void },
): Promise<void> {
  akapen.append('\n## second round\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  const other = await page.context().newPage();
  await other.goto(akapen.url);
  await expect(other.locator('.row').first()).toBeVisible();
  akapen.append('\n## third round\n');
  await other.locator('#nextRound').click();
  await expect(other.locator('#round')).toHaveText('R003');
  await expect(page.locator('#movedBar')).toBeVisible();
}

test('carries a comment written elsewhere on an earlier round and not one on the screen own round', async ({
  page,
  request,
  akapen,
}) => {
  await screenOneRoundBehind(page, akapen);

  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'left open on round one',
    round: 1,
  });
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);
  await expect(page.locator('#railCarried .bubble')).toContainText('left open on round one');

  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 15,
    endLine: 15,
    body: 'written on the screen own round',
    round: 2,
  });
  await expect(page.locator(A.rail).filter({ hasText: 'written on the screen own round' })).toHaveCount(1);
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);
  await expect(page.locator('#railCarried')).not.toContainText('written on the screen own round');
});

test('says a failed resolve on its bubble when a reply landed on it while the request was out', async ({
  page,
  request,
  akapen,
}) => {
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'resolve that fails late',
  });
  await openSettled(page, akapen.url);
  const held = Promise.withResolvers<void>();
  let reached = false;
  // Refused here, never forwarded: the server must not resolve the comment the page reports as failed.
  await page.route('**/api/comments/*/resolve', async (route) => {
    reached = true;
    await held.promise;
    await route.fulfill({ status: 500, body: 'refused' });
  });
  const bubble = page.locator(A.rail).filter({ hasText: 'resolve that fails late' });
  const toggle = `/api/comments/${comment.id}/resolve`;
  // Resolved and reopened elsewhere, each shown: every one puts a new head on the bubble.
  const flip = async () => {
    await writeElsewhere(request, akapen.url, toggle);
    await expect(bubble).toHaveClass(/resolved/);
    await writeElsewhere(request, akapen.url, toggle);
    await expect(bubble).not.toHaveClass(/resolved/);
  };
  // The button pressed is one an earlier update put there: it was built inside a bubble
  // that was thrown away, which is the one a late lookup would report on.
  await flip();
  await bubble.getByRole('button', { name: 'Resolve' }).click();
  await expect.poll(() => reached).toBe(true);

  // And the head it was in is replaced again while the request is out.
  await flip();
  held.resolve();
  await expect(bubble.locator('.bubble-error')).toContainText('update failed');
  await expect(bubble).not.toHaveClass(/resolved/);
});

test('counts a draft sent on an earlier round once when a refresh showed it first', async ({
  page,
  akapen,
}) => {
  await screenOneRoundBehind(page, akapen);

  const answerHeld = Promise.withResolvers<void>();
  const refresh = Promise.withResolvers<void>();
  let reached = false;
  await page.route('**/api/comments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const answer = await route.fetch();
    reached = true;
    await answerHeld.promise;
    await route.fulfill({ response: answer });
  });
  await openDraft(page);
  await page.locator(A.ta).fill('sent on the earlier round');
  await page.locator(`${A.draft} button.primary`).click();
  await expect.poll(() => reached).toBe(true);
  await expect(page.locator(A.rail).filter({ hasText: 'sent on the earlier round' })).toHaveCount(1);

  await page.route(REFRESH_GET, async (route) => {
    await refresh.promise;
    await route.continue();
  });
  answerHeld.resolve();
  await expect(page.locator(A.draft)).toHaveCount(0);
  await expect(page.locator('#count')).toHaveText('1 open / 1');
  await expect(page.locator(A.rail)).toHaveCount(1);
  refresh.resolve();
});

/** A comment on R001, with the screen on R002. Returns the comment's id. */
async function historyWithReply(
  page: Page,
  request: APIRequestContext,
  akapen: { url: string; append: (t: string) => void },
) {
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'said on a closed round',
  });
  await openSettled(page, akapen.url);
  akapen.append('\n## second round heading\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  return comment.id;
}

test('shows a reply written while an earlier round was being opened', async ({ page, request, akapen }) => {
  const id = await historyWithReply(page, request, akapen);
  const held = Promise.withResolvers<void>();
  let answered = false;
  await page.route(/\/api\/doc\?round=1$/, async (route) => {
    const answer = await route.fetch();
    answered = true;
    await held.promise;
    await route.fulfill({ response: answer });
  });
  await page.locator('#roundPick').selectOption('1');
  await expect.poll(() => answered).toBe(true);

  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${id}/replies`,
    { body: 'written while opening' },
    true,
  );
  await page.waitForTimeout(500);
  held.resolve();
  await expect(page.locator('#round')).toHaveText('R001');
  await expect(page.locator(A.rail).locator('.reply-body')).toHaveText('written while opening');
});

test('keeps a reply box typed in under a comment another one wrote while your own answer was out', async ({
  page,
  request,
  akapen,
}) => {
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'comment with the reply in flight',
  });
  await openSettled(page, akapen.url);
  const held = Promise.withResolvers<void>();
  let reached = false;
  await page.route('**/api/comments/*/replies', async (route) => {
    const answer = await route.fetch();
    reached = true;
    await held.promise;
    await route.fulfill({ response: answer });
  });
  const mine = page.locator(A.rail).filter({ hasText: 'comment with the reply in flight' });
  await mine.hover();
  await mine.locator('.reply-input').fill('sent from the page');
  await mine.locator('.reply-send').click();
  await expect.poll(() => reached).toBe(true);

  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 15,
    endLine: 15,
    body: 'comment that arrived meanwhile',
  });
  const later = page.locator(A.rail).filter({ hasText: 'comment that arrived meanwhile' });
  await expect(later).toHaveCount(1);
  await later.hover();
  const box = later.locator('.reply-input');
  await box.fill('half typed under the new one');
  await box.evaluate((n) => n.setAttribute('data-same-node', 'yes'));

  held.resolve();
  await expect(mine.locator('.reply-body')).toHaveText('sent from the page');
  await expect(box).toHaveAttribute('data-same-node', 'yes');
  await expect(box).toHaveValue('half typed under the new one');
});

test('keeps a reply box typed in under a comment another one wrote while your own comment was out', async ({
  page,
  request,
  akapen,
}) => {
  const held = Promise.withResolvers<void>();
  let reached = false;
  await page.route('**/api/comments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const answer = await route.fetch();
    reached = true;
    await held.promise;
    await route.fulfill({ response: answer });
  });
  await openDraft(page);
  await page.locator(A.ta).fill('my comment held on the way back');
  await page.locator(`${A.draft} button.primary`).click();
  await expect.poll(() => reached).toBe(true);

  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 16,
    endLine: 16,
    body: 'other comment arrived meanwhile',
  });
  const later = page.locator(A.rail).filter({ hasText: 'other comment arrived meanwhile' });
  await expect(later).toHaveCount(1);
  await later.hover();
  const box = later.locator('.reply-input');
  await box.fill('half typed under the arrival');
  await box.evaluate((n) => n.setAttribute('data-same-node', 'yes'));

  held.resolve();
  await expect(page.locator(A.draft)).toHaveCount(0);
  await expect(page.locator(A.rail).filter({ hasText: 'my comment held on the way back' })).toHaveCount(1);
  await expect(box).toHaveAttribute('data-same-node', 'yes');
  await expect(box).toHaveValue('half typed under the arrival');
});

test('keeps the carried count in history when a reply lands', async ({ page, request, akapen }) => {
  const id = await historyWithReply(page, request, akapen);
  await page.locator('#roundPick').selectOption('1');
  await expect(page.locator('#round')).toHaveText('R001');
  await expect(page.locator('#count')).toHaveText('1 open / 1 (+ 1 earlier)');

  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${id}/replies`,
    { body: 'reply in history view' },
    true,
  );
  await expect(page.locator(A.rail).locator('.reply-body')).toHaveText('reply in history view');
  await expect(page.locator('#count')).toHaveText('1 open / 1 (+ 1 earlier)');
});

test('keeps the resolve button focused when a reply lands on its comment', async ({
  page,
  request,
  akapen,
}) => {
  const { comment } = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'button stays put',
  });
  await openSettled(page, akapen.url);
  const bubble = page.locator(A.rail).filter({ hasText: 'button stays put' });
  const button = bubble.getByRole('button', { name: 'Resolve' });
  await button.focus();
  await button.evaluate((n) => n.setAttribute('data-same-node', 'yes'));

  await writeElsewhere(
    request,
    akapen.url,
    `/api/comments/${comment.id}/replies`,
    { body: 'reply beside the button' },
    true,
  );
  await expect(bubble.locator('.reply-body')).toHaveText('reply beside the button');
  await expect(button).toHaveAttribute('data-same-node', 'yes');
  await expect(button).toBeFocused();
});

test('keeps a carried comment resolved elsewhere while a reply is typed under it', async ({
  page,
  request,
  akapen,
}) => {
  const typed = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'carried with a reply typed',
  });
  const empty = await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 15,
    endLine: 15,
    body: 'carried with an empty box',
  });
  await openSettled(page, akapen.url);
  akapen.append('\n## second round\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#railCarried .bubble')).toHaveCount(2);

  const bubble = page.locator('#railCarried .bubble').filter({ hasText: 'carried with a reply typed' });
  await bubble.hover();
  const box = bubble.locator('.reply-input');
  await box.fill('answer being written');
  await box.evaluate((n) => n.setAttribute('data-same-node', 'yes'));

  const blank = page.locator('#railCarried .bubble').filter({ hasText: 'carried with an empty box' });
  await blank.hover();
  await blank.locator('.reply-input').fill('   ');
  await writeElsewhere(request, akapen.url, `/api/comments/${empty.comment.id}/resolve`);
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);

  const replies = `/api/comments/${typed.comment.id}/replies`;
  await writeElsewhere(request, akapen.url, replies, { body: 'lands while it is still open' }, true);
  await expect(bubble.locator('.reply-body')).toHaveText(['lands while it is still open']);
  await expect(bubble).not.toHaveClass(/resolved/);
  await expect(page.locator('#railCarried h2')).toHaveText('1 unresolved from earlier rounds');

  await writeElsewhere(request, akapen.url, `/api/comments/${typed.comment.id}/resolve`);
  await expect(bubble).toHaveClass(/resolved/);
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1);
  await expect(box).toHaveAttribute('data-same-node', 'yes');
  await expect(box).toHaveValue('answer being written');
  await expect(page.locator('#railCarried h2')).toHaveText('0 unresolved from earlier rounds');
  await expect(page.locator('#count')).toHaveText('0 open / 0');
});

test('shows both a failed reply and a failed resolve on the same bubble', async ({
  page,
  request,
  akapen,
}) => {
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'fails twice over',
  });
  await openSettled(page, akapen.url);
  await page.route('**/api/comments/*/replies', (route) => route.fulfill({ status: 500, body: 'refused' }));
  await page.route('**/api/comments/*/resolve', (route) => route.fulfill({ status: 500, body: 'refused' }));
  const bubble = page.locator(A.rail).filter({ hasText: 'fails twice over' });
  await bubble.hover();
  await bubble.locator('.reply-input').fill('will not be sent');
  await bubble.locator('.reply-send').click();
  await expect(bubble.locator('.reply-form .bubble-error')).toContainText('reply failed');

  await bubble.getByRole('button', { name: 'Resolve' }).click();
  await expect(bubble.locator('.bubble-error')).toHaveCount(2);
  await expect(bubble.locator('.reply-form .bubble-error')).toContainText('reply failed');
  await expect(bubble.locator(':scope > .bubble-error')).toContainText('update failed');
});

test('shows your own reply and resolve at once, before the page has asked for the comments again', async ({
  page,
  request,
  akapen,
}) => {
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'goes on to the next round',
  });
  await openSettled(page, akapen.url);
  akapen.append('\n## second round\n');
  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await writeElsewhere(request, akapen.url, '/api/comments', {
    startLine: 14,
    endLine: 14,
    body: 'stays on this round',
  });
  const mine = page.locator(A.rail).filter({ hasText: 'stays on this round' });
  await expect(mine).toHaveCount(1);
  const carried = page.locator('#railCarried .bubble').filter({ hasText: 'goes on to the next round' });
  await expect(carried).toHaveCount(1);

  const held = Promise.withResolvers<void>();
  await page.route(REFRESH_GET, async (route) => {
    await held.promise;
    await route.continue();
  });
  await mine.hover();
  await mine.locator('.reply-input').fill('answered without waiting');
  await mine.locator('.reply-send').click();
  await expect(mine.locator('.reply-body')).toHaveText(['answered without waiting']);

  await carried.getByRole('button', { name: 'Resolve' }).click();
  await expect(carried).toHaveClass(/resolved/);
  held.resolve();
  await expect(carried).toHaveCount(0);
});
