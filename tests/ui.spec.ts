import { expect, test, type Page } from '@playwright/test';

const cards = (page: Page) => page.locator('.photo-card');
const currentFile = (page: Page) => page.locator('.detail-file h3');
const currentDecision = (page: Page) => page.locator('.detail-decision');

function card(page: Page, fileName: string) {
  return cards(page).filter({
    has: page.getByRole('button', { name: `查看 ${fileName}`, exact: true }),
  });
}

async function viewPhoto(page: Page, fileName: string) {
  await page.getByRole('button', { name: `查看 ${fileName}`, exact: true }).click();
  await expect(currentFile(page)).toHaveText(fileName);
}

async function selectPhoto(page: Page, fileName: string) {
  await card(page, fileName).hover();
  await card(page, fileName).getByRole('button', { name: `选择 ${fileName}`, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('全部照片 24');
  await expect(cards(page)).toHaveCount(24);
});

test('searches bib numbers and person labels, recovers from an empty result', async ({ page }) => {
  const search = page.getByRole('textbox', { name: '搜索照片' });
  await search.fill('08');
  await expect(cards(page)).toHaveCount(6);
  await expect(page.locator('.photo-bib')).toHaveText(Array(6).fill('#08'));

  await search.fill('蓝队');
  await expect(cards(page)).toHaveCount(6);
  await expect(page.getByRole('button', { name: '移除标签 蓝队 · 示例', exact: true })).toBeVisible();

  await search.fill('不存在的运动员-999999');
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '这里暂时没有照片', exact: true })).toBeVisible();
  await expect(currentFile(page)).toHaveCount(0);
  await page.getByRole('button', { name: '重置筛选条件', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(cards(page)).toHaveCount(24);
  await expect.poll(async () => cards(page).first().locator('img').evaluate((image) =>
    (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('workspace.png') });
});

test('K advances to the adjacent unreviewed photo, Z restores it, typing J does not reject', async ({ page }) => {
  await page.getByRole('navigation', { name: '照片分类' })
    .getByRole('button', { name: /^待筛选/ }).click();
  await expect(currentFile(page)).toHaveText('DSC_1042.jpg');
  await expect(cards(page)).toHaveCount(17);

  await page.keyboard.press('k');
  await expect(currentFile(page)).toHaveText('DSC_1044.jpg');
  await expect(cards(page)).toHaveCount(16);
  await expect(card(page, 'DSC_1042.jpg')).toHaveCount(0);

  await page.keyboard.press('z');
  await expect(currentFile(page)).toHaveText('DSC_1042.jpg');
  await expect(cards(page)).toHaveCount(17);
  await expect(currentDecision(page)).toHaveText('待筛选');

  const labelInput = page.getByRole('textbox', { name: '添加人物标签', exact: true });
  await labelInput.focus();
  await page.keyboard.press('j');
  await expect(labelInput).toHaveValue('j');
  await expect(currentFile(page)).toHaveText('DSC_1042.jpg');
  await expect(currentDecision(page)).toHaveText('待筛选');
  await expect(cards(page)).toHaveCount(17);
});

test('sets person labels in a batch, searches them, and undoes the whole batch', async ({ page }) => {
  await selectPhoto(page, 'DSC_1041.jpg');
  await selectPhoto(page, 'DSC_1042.jpg');
  await expect(page.locator('.batch-count')).toContainText('2 张');
  await page.getByRole('combobox', { name: '批量编辑字段' }).selectOption('athleteTags');
  await page.getByRole('textbox', { name: '批量编辑内容' }).fill('决赛 A 组,李明');
  await page.locator('.batch-bar').getByRole('button', { name: '应用', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('批量设置人物标签 · 2 张照片');

  const search = page.getByRole('textbox', { name: '搜索照片' });
  await search.fill('李明');
  await expect(cards(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: '移除标签 李明', exact: true })).toBeVisible();
  await page.getByTitle('撤销最近一次操作（Z）', { exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已撤销：批量设置人物标签');
  await expect(cards(page)).toHaveCount(0);

  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  await expect(cards(page)).toHaveCount(24);
  await viewPhoto(page, 'DSC_1041.jpg');
  await expect(page.getByRole('button', { name: '移除标签 蓝队 · 示例', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '移除标签 李明', exact: true })).toHaveCount(0);
});

test('compares a burst side by side and changes each photograph independently', async ({ page }) => {
  await page.getByRole('navigation', { name: '智能分类' })
    .getByRole('button', { name: /^相似照片/ }).click();
  await page.getByRole('button', { name: '并排对比', exact: true }).first().click();
  const comparison = page.getByRole('dialog', { name: '好照片，值得放在一起看', exact: true });
  await expect(comparison.locator('.compare-photo')).toHaveCount(4);
  const second = comparison.locator('.compare-photo').filter({ hasText: 'DSC_1042.jpg' });
  const fourth = comparison.locator('.compare-photo').filter({ hasText: 'DSC_1044.jpg' });
  await second.getByRole('button', { name: '保留', exact: true }).click();
  await expect(second.locator('.image-badge')).toHaveText('已保留');
  await fourth.getByRole('button', { name: '淘汰', exact: true }).click();
  await expect(fourth.locator('.image-badge')).toHaveText('已淘汰');
  await expect(second.locator('.image-badge')).toHaveText('已保留');
  await page.screenshot({ path: test.info().outputPath('comparison.png') });

  await comparison.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(fourth.locator('.image-badge')).toHaveCount(0);
  await second.getByRole('button', { name: '重置 DSC_1042.jpg 为待筛选', exact: true }).click();
  await expect(second.locator('.image-badge')).toHaveCount(0);
  await comparison.getByRole('button', { name: '完成比较', exact: true }).click();
  await expect(comparison).toHaveCount(0);
  await viewPhoto(page, 'DSC_1042.jpg');
  await expect(currentDecision(page)).toHaveText('待筛选');
});

test('validates a time range and filters by the actual captured time', async ({ page }) => {
  await page.getByRole('button', { name: '全部时间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '按拍摄时间筛选', exact: true });
  await dialog.getByLabel('开始时间', { exact: true }).fill('2026-10-18T08:45');
  await dialog.getByLabel('结束时间', { exact: true }).fill('2026-10-18T08:44');
  await expect(dialog.getByRole('button', { name: '应用筛选', exact: true })).toBeDisabled();
  await expect(dialog.getByText('结束时间需晚于开始时间。', { exact: true })).toBeVisible();
  await dialog.getByLabel('结束时间', { exact: true }).fill('2026-10-18T08:46');
  await dialog.getByRole('button', { name: '应用筛选', exact: true }).click();

  await expect(cards(page)).toHaveCount(6);
  await expect(page.locator('.photo-name > span[title]')).toHaveText([
    'DSC_1047.jpg', 'DSC_1048.jpg', 'DSC_1049.jpg', 'DSC_1050.jpg', 'DSC_1051.jpg', 'DSC_1052.jpg',
  ]);
  await page.getByRole('button', { name: '已选时段', exact: true }).click();
  await page.getByRole('button', { name: '清除时间范围', exact: true }).click();
  await expect(cards(page)).toHaveCount(24);
});

test('persists a star rating across reload and supports clearing it', async ({ page }) => {
  await viewPhoto(page, 'DSC_1042.jpg');
  await page.getByRole('button', { name: '评为 5 星', exact: true }).click();
  await expect(page.locator('.rating-row .rating')).toHaveAttribute('aria-label', '5 星');
  await expect(card(page, 'DSC_1042.jpg').locator('.tiny-rating')).toHaveText('5');
  await page.reload();
  await viewPhoto(page, 'DSC_1042.jpg');
  await expect(page.locator('.rating-row .rating')).toHaveAttribute('aria-label', '5 星');
  await page.getByRole('button', { name: '评为 5 星', exact: true }).click();
  await expect(page.locator('.rating-row .rating')).toHaveAttribute('aria-label', '0 星');
  await expect(card(page, 'DSC_1042.jpg').locator('.tiny-rating')).toHaveCount(0);
});

test('demo import, OCR, and export show explicit limits without reporting a fake success', async ({ page }) => {
  await page.getByRole('button', { name: '导入文件夹', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('当前是界面演示。请在 Windows 客户端中导入本地照片文件夹');
  await expect(cards(page)).toHaveCount(24);
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();

  await page.getByRole('button', { name: '识别号码布', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('号码识别需要 Windows 客户端读取原片');
  await expect(page.getByRole('alert')).toContainText('手工示例');
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();

  await page.getByRole('button', { name: /^导出照片/ }).click();
  const exportDialog = page.getByRole('dialog', { name: '把精彩带走', exact: true });
  await exportDialog.getByRole('button', { name: '选择位置并导出', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('演示相册，没有可导出的原片');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(cards(page)).toHaveCount(24);
});

test('a fresh desktop album shows the import state without requiring unused API methods', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'albumApi', {
      value: {
        getAlbum: async () => null,
        onProgress: () => () => {},
      },
      configurable: true,
    });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '你的精彩，值得被看见。', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导入照片文件夹', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '识别号码布', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^导出照片/ })).toBeDisabled();
  await expect(cards(page)).toHaveCount(0);
  await expect(currentFile(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('empty-album.png') });
});
