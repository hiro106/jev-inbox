import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { demoDecision } from '../../shared/demo';

async function closeDetail(page: Page) {
  const close = page.getByRole('button', { name: '詳細を閉じる' });
  if (await close.isVisible()) await close.click();
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '受信トレイ', exact: true })).toBeVisible();
});

test('loads a clearly labeled demo and supports search and filtering', async ({ page }) => {
  await closeDetail(page);
  await expect(page.getByRole('button', { name: 'デモモード' })).toBeVisible();
  await page.getByRole('textbox', { name: '問い合わせを検索' }).fill('二重');
  await expect(page.locator('.ticket-row')).toHaveCount(1);
  await page.getByRole('button', { name: '検索をクリア' }).click();
  await page
    .locator('.filter-tabs')
    .getByRole('button', { name: /未仕分け/ })
    .click();
  await expect(page.locator('.ticket-row')).toHaveCount(3);
});

test('adds, evaluates, reviews and resolves a ticket and retains it on reload', async ({
  page,
}) => {
  await closeDetail(page);
  await page.getByRole('button', { name: '問い合わせを追加', exact: true }).click();
  await page.getByLabel('差出人', { exact: true }).fill('テスト担当者');
  await page.getByLabel('件名', { exact: true }).fill('本番で全員エラー');
  await page
    .getByLabel('本文', { exact: true })
    .fill('全員の本番環境が停止しています。至急対応をお願いします。');
  await page.getByRole('button', { name: '追加する', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '問い合わせの詳細' });
  await detail.getByRole('button', { name: 'デモで仕分ける', exact: true }).click();
  await expect(detail.getByText('人の確認をお願いします')).toBeVisible();
  await expect(detail.getByRole('button', { name: '対応済みに', exact: true })).toBeDisabled();
  await detail.getByRole('button', { name: '確認・修正' }).click();
  await detail.getByRole('combobox', { name: '分類', exact: true }).selectOption('technical');
  await detail.getByRole('button', { name: '確認して確定' }).click();
  await detail.getByRole('button', { name: '対応済みに', exact: true }).click();
  await expect(detail.getByRole('button', { name: '対応済みを取り消す' })).toBeVisible();
  await page.reload();
  if (!(await detail.isVisible()))
    await page.getByRole('button', { name: '本番で全員エラー、テスト担当者' }).click();
  await expect(
    detail.getByRole('heading', { name: '本番で全員エラー', exact: true }),
  ).toBeVisible();
  await expect(detail.getByRole('button', { name: '対応済みを取り消す' })).toBeVisible();
});

test('batch processes unclassified tickets without making live calls', async ({ page }) => {
  await closeDetail(page);
  const requests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/evaluate')) requests.push(req.postDataJSON().mode);
  });
  await page.getByRole('button', { name: '未仕分けを一括仕分け' }).click();
  await expect(page.getByRole('status')).toContainText('3件をデモで仕分けしました');
  expect(requests).toEqual(['demo', 'demo', 'demo']);
  await expect(page.getByRole('button', { name: '未仕分けを一括仕分け' })).toBeDisabled();
});

test('changes the review threshold and never persists an API key', async ({ page }) => {
  await closeDetail(page);
  await page.getByRole('button', { name: 'ルールと接続' }).click();
  await page.getByRole('slider', { name: '確信度の基準' }).fill('99');
  await page.getByLabel('TypeSafe APIキー', { exact: true }).fill('test-only-not-a-real-key');
  await page.getByRole('button', { name: '設定を保存' }).click();
  await page
    .locator('.filter-tabs')
    .getByRole('button', { name: /要確認/ })
    .click();
  await expect(page.locator('.ticket-row')).toHaveCount(4);
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain('test-only-not-a-real-key');
  await page.reload();
  await closeDetail(page);
  await page.getByRole('button', { name: 'ルールと接続' }).click();
  await expect(page.getByLabel('TypeSafe APIキー', { exact: true })).toHaveValue('');
  await expect(page.getByRole('slider')).toHaveValue('99');
});

test('exports a restorable backup and skips duplicate IDs on import', async ({ page }) => {
  await closeDetail(page);
  await page.getByRole('button', { name: '書き出し', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSONでバックアップ' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/jev-inbox-.*\.json/);
  const path = await download.path();
  await page.getByLabel('JSONファイルを選択').setInputFiles(path!);
  await expect(page.getByRole('status')).toContainText('重複するIDの8件はスキップ');
  await expect(page.locator('.ticket-row')).toHaveCount(8);
});

test('rejects an invalid backup and preserves current data', async ({ page }) => {
  await closeDetail(page);
  await page
    .getByLabel('JSONファイルを選択')
    .setInputFiles({
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"version":9,"tickets":[]}'),
    });
  await expect(page.getByRole('alert')).toContainText('現在のデータは変更していません');
  await expect(page.locator('.ticket-row')).toHaveCount(8);
});

test('preserves unprocessed state when the server fails', async ({ page }) => {
  await closeDetail(page);
  await page.route('**/api/evaluate', (route) =>
    route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'テスト用の接続失敗' }),
    }),
  );
  await page.getByRole('button', { name: '未仕分けを一括仕分け' }).click();
  await expect(page.getByRole('alert')).toContainText('テスト用の接続失敗');
  await page
    .locator('.filter-tabs')
    .getByRole('button', { name: /未仕分け/ })
    .click();
  await expect(page.locator('.ticket-row')).toHaveCount(3);
});

test('editing resets prior judgment and deleting removes the selected record', async ({ page }) => {
  const detail = page.getByRole('complementary', { name: '問い合わせの詳細' });
  if (!(await detail.isVisible()))
    await page.getByRole('button', { name: /今月の請求が二重/ }).click();
  await detail.getByRole('button', { name: '問い合わせの操作' }).click();
  await page.getByRole('button', { name: '内容を編集' }).click();
  await page.getByLabel('件名', { exact: true }).fill('編集後の問い合わせ');
  await page.getByRole('button', { name: '更新する' }).click();
  await expect(detail.getByText('この声は、まだ仕分け前です。')).toBeVisible();
  await detail.getByRole('button', { name: '問い合わせの操作' }).click();
  await page.getByRole('button', { name: '削除', exact: true }).click();
  await page.getByRole('button', { name: '削除する', exact: true }).click();
  await expect(page.locator('.ticket-row')).toHaveCount(7);
  await expect(page.getByRole('button', { name: /編集後の問い合わせ、/ })).toHaveCount(0);
});

test('lays out without horizontal overflow and captures the interface', async ({
  page,
}, testInfo) => {
  await closeDetail(page);
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasOverflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
  await page.getByRole('button', { name: /今月の請求が二重/ }).click();
  await page.screenshot({ path: testInfo.outputPath('detail.png'), fullPage: true });
});

test('preserves corrupt storage until the user explicitly resets it', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('jev-inbox.workspace.v1', '{broken'));
  await page.reload();
  await expect(page.locator('.alert')).toContainText('元のデータは上書きしていません');
  expect(await page.evaluate(() => localStorage.getItem('jev-inbox.workspace.v1'))).toBe('{broken');
  await page.getByRole('button', { name: 'ルールと接続' }).click();
  await page.getByRole('button', { name: 'サンプルで初期化' }).click();
  await page.getByRole('button', { name: '初期化する' }).click();
  await closeDetail(page);
  await expect(page.locator('.ticket-row')).toHaveCount(8);
  await expect(page.locator('.alert')).toHaveCount(0);
});

test('has accessible names and readable contrast in the workspace and settings', async ({
  page,
}) => {
  await closeDetail(page);
  const check = async () => {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      })),
    ).toEqual([]);
  };
  await check();
  await page.getByRole('button', { name: 'ルールと接続' }).click();
  await check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('supports the live-mode UI without persisting the key or silently using demo results', async ({
  page,
}) => {
  await closeDetail(page);
  await page.getByRole('button', { name: 'ルールと接続' }).click();
  await page.getByRole('radio', { name: /Jevに接続/ }).check();
  await page.getByLabel('TypeSafe APIキー', { exact: true }).fill('test-only-key');
  await page.getByRole('button', { name: '設定を保存' }).click();
  await page.route('**/api/evaluate', (route) => {
    const body = route.request().postDataJSON();
    expect(body.mode).toBe('live');
    expect(route.request().headers()['x-typesafe-api-key']).toBe('test-only-key');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...demoDecision(body.ticket),
        source: 'live',
        model: 'test-mock-jev',
      }),
    });
  });
  await page.getByRole('button', { name: /パスワードの再設定メールが届きません、/ }).click();
  const detail = page.getByRole('complementary', { name: '問い合わせの詳細' });
  await detail.getByRole('button', { name: 'Jevで仕分ける', exact: true }).click();
  await expect(detail.getByText('Jev判定', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-only-key');
});
