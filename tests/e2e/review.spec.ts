/**
 * 実ブラウザでの回帰。
 *
 * ここに並んでいるのは全部、実際に壊して人か CodeRabbit に見つけてもらった挙動。
 * store 層のテストでは 1 件も捕まらなかったので、DOM を直接見る。
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

const A = { rail: '#railAnchored .bubble', draft: '#rail .bubble.draft', ta: '#rail .bubble.draft textarea' };

test.beforeEach(async ({ page, akapen }) => {
  await page.goto(akapen.url);
  await expect(page.locator('.row').first()).toBeVisible();
});

/** ガターの + を押して下書きを開く */
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

test('本文には行を挿入しない (コメントの有無で高さが変わらない)', async ({ page }) => {
  const before = await page.locator('#doc').boundingBox();
  await openDraft(page);
  await post(page, '高さを変えないことの確認');
  await expect(page.locator(A.rail)).toHaveCount(1);
  const after = await page.locator('#doc').boundingBox();
  expect(after!.height).toBe(before!.height);
});

test('吹き出しはアンカー行に揃い、重ならない', async ({ page }) => {
  for (const i of [1, 2, 3]) {
    await openDraft(page, i);
    await post(page, `L${i} への指摘。押し下げの確認用に少し長めにしておく。`);
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
    expect(b.top).toBeGreaterThanOrEqual(b.rowTop - 1); // アンカー行より上に出ない
    if (i > 0) expect(b.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom - 1); // 重ならない
  }
});

test('サーバ由来のイベントで本文の DOM と選択が壊れない', async ({ page, request, akapen }) => {
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

  // 別クライアントが投稿しても、こちらの画面は変わらない
  await request.post(`${akapen.url}/api/comments`, {
    data: { startLine: 9, endLine: 9, body: '別クライアント' },
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

test('入力中に doc payload が来ても textarea を作り直さない (IME が切れる)', async ({
  page,
  request,
  akapen,
}) => {
  await openDraft(page);
  await page.locator(A.ta).fill('へんかんちゅう');
  await page.evaluate((sel) => {
    const ta = document.querySelector(sel) as HTMLTextAreaElement;
    ta.dataset['mark'] = 'original';
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  }, A.ta);

  await request.post(`${akapen.url}/api/comments`, {
    data: { startLine: 9, endLine: 9, body: '別クライアント' },
  });
  await page.waitForTimeout(700);

  const ta = page.locator(A.ta);
  await expect(ta).toHaveAttribute('data-mark', 'original'); // 同じ要素のまま
  await expect(ta).toBeFocused();
  await expect(ta).toHaveValue('へんかんちゅう');
});

test('範囲を伸ばした下書きは伸ばした範囲で投稿される', async ({ page }) => {
  await page.locator('.row').nth(1).click();
  await page.keyboard.press('c');
  await expect(page.locator(`${A.draft} .at`)).toHaveText('L2');

  await page.locator(A.ta).blur();
  await page.keyboard.press('Shift+J');
  await page.keyboard.press('Shift+J');
  await page.keyboard.press('c');
  await expect(page.locator(`${A.draft} .at`)).toHaveText('L2-4');

  await post(page, '範囲コメント');
  await expect(page.locator(`${A.rail} .at`)).toHaveText('L2-4');
});

test('キーボードだけでコメントを打てる', async ({ page }) => {
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('c');
  await expect(page.locator(A.ta)).toBeFocused();
  // 入力中は j/k が本文に入り、行フォーカスは動かない
  await page.keyboard.type('jk キーボードから');
  await expect(page.locator(A.ta)).toHaveValue('jk キーボードから');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator(A.draft)).toHaveCount(0);
  await expect(page.locator(A.rail)).toHaveCount(1);
});

test('ラウンドを切るまで本文は凍結され、締めても指摘は残る', async ({ page, akapen }) => {
  await openDraft(page);
  await post(page, 'R001 の指摘');

  // エージェントの編集を模す。本文は差し替わらず、バナーだけ出る
  akapen.append('\n## エージェントが足した節\n\n直した結果。\n');
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#doc')).not.toContainText('エージェントが足した節');
  await expect(page.locator('#round')).toHaveText('R001');

  await page.locator('#nextRound').click();
  await expect(page.locator('#round')).toHaveText('R002');
  await expect(page.locator('#doc')).toContainText('エージェントが足した節');
  await expect(page.locator(A.rail)).toHaveCount(0); // 持ち越さない
  await expect(page.locator('#railCarried .bubble')).toHaveCount(1); // 消えてはいない
  await expect(page.locator('#count')).toContainText('過去 1');
});
