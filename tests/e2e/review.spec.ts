/**
 * Regressions, in a real browser.
 *
 * Every case here is behaviour that actually broke and was caught by a person or by
 * CodeRabbit. The storage-layer tests caught none of them, so these look at the DOM.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

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
  // The text stays Japanese on purpose: this is what an IME composition looks like
  await page.locator(A.ta).fill('へんかんちゅう');
  await page.evaluate((sel) => {
    const ta = document.querySelector(sel) as HTMLTextAreaElement;
    ta.dataset['mark'] = 'original';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  }, A.ta);

  await request.post(`${akapen.url}/api/comments`, {
    data: { startLine: 9, endLine: 9, body: 'from another client' },
  });
  await page.waitForTimeout(700);

  const ta = page.locator(A.ta);
  await expect(ta).toHaveAttribute('data-mark', 'original'); // still the same element
  await expect(ta).toBeFocused();
  await expect(ta).toHaveValue('へんかんちゅう');
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
  // The fixture stays Japanese on purpose (it also exercises CJK wrapping), so the
  // expected text is quoted from it verbatim
  await expect(page.locator('#doc')).toContainText('<b>太字にはならない</b>');
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

  // A closed round is read-only for the document, not for the conversation. Hover, not
  // click: clicking a carried bubble opens that round's history, so a form that needed a
  // click to appear could never be reached with a mouse.
  await carried.hover();
  await carried.locator('.reply-input').fill('still open because X');
  await carried.locator('.reply-send').click();
  await expect(page.locator('#railCarried .bubble').first().locator('.reply-body')).toHaveCount(2);
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
  // Still R001, still read-only.
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
  // The + is still drawn where it was: same 18px square, same 8px clear of the text,
  // top-aligned to the row. Widening the hit area must not move what is on screen.
  expect(addBox.width).toBe(18);
  expect(addBox.height).toBe(18);
  expect(body.x - (addBox.x + addBox.width)).toBeCloseTo(8, 1);
  expect(addBox.y).toBeCloseTo(rowBox.y, 1);

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
