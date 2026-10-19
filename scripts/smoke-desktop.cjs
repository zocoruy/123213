// Run after `npm run build`, on a graphical desktop (DISPLAY is needed on Linux).
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const sharp = require('sharp');

(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sprintselect-desktop-')));
  const source = path.join(root, '赛事照片');
  const destination = path.join(root, '导出');
  const userData = path.join(root, 'user-data');
  await fs.mkdir(source); await fs.mkdir(destination);
  await sharp(Buffer.from('<svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="700" fill="white"/><text x="500" y="425" text-anchor="middle" font-family="Arial, DejaVu Sans, sans-serif" font-weight="bold" font-size="156" fill="black">00127</text></svg>'))
    .png().toFile(path.join(source, '001-number.png'));
  await fs.copyFile(path.join(__dirname, '../public/demo/sports-03.jpg'), path.join(source, '002-baseball.jpg'));
  await fs.copyFile(path.join(__dirname, '../public/demo/sports-03.jpg'), path.join(source, '003-baseball-copy.jpg'));
  await fs.copyFile(path.join(__dirname, '../public/demo/sports-01.jpg'), path.join(source, '004-ski.jpg'));
  await fs.writeFile(path.join(source, 'broken.jpg'), 'not a photo');
  await fs.writeFile(path.join(source, 'camera.nef'), 'RAW placeholder');
  const original = await fs.readFile(path.join(source, '001-number.png'));
  const originalChecksum = createHash('sha256').update(original).digest('hex');
  const errors = [];
  let desktop;
  const launch = () => electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, path.resolve(__dirname, '..')],
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, VITE_DEV_SERVER_URL: '', XDG_CACHE_HOME: path.join(root, 'cache') },
  });
  try {
    desktop = await launch();
    let page = await desktop.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: '你的精彩，值得被看见。' })).toBeVisible();
    assert.equal(await page.evaluate(() => window.albumApi.getAlbum()), null);
    await desktop.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, source);
    await page.getByRole('button', { name: '导入照片文件夹', exact: true }).click();
    await expect(page.locator('.photo-card')).toHaveCount(4);
    await expect(page.locator('.detail-file h3')).toHaveText('001-number.png');
    const imported = await page.evaluate(() => window.albumApi.getAlbum());
    assert.equal(imported.photos.length, 4);
    assert.equal(imported.errors.length, 2);
    const first = imported.photos.find((photo) => photo.fileName === '001-number.png');
    assert.ok(first);
    assert.equal(imported.photos.filter((photo) => photo.similarGroupId).length, 2);
    await expect.poll(() => page.locator('.photo-card img').evaluateAll((images) => images.every((img) => img.complete && img.naturalWidth > 0))).toBe(true);

    await page.keyboard.press('k');
    await expect(page.locator('.detail-file h3')).toHaveText('002-baseball.jpg');
    await page.getByRole('button', { name: '查看 001-number.png', exact: true }).click();
    await page.getByRole('textbox', { name: '添加人物标签', exact: true }).fill('陈一');
    await page.getByRole('textbox', { name: '添加人物标签', exact: true }).press('Enter');
    await expect(page.locator('.person-tag')).toContainText('陈一');
    await page.getByRole('button', { name: '选择 001-number.png', exact: true }).click();
    await page.getByRole('button', { name: '识别号码布', exact: true }).click();
    await expect(page.locator('.bib-tag')).toContainText('00127', { timeout: 30000 });
    const recognized = await page.evaluate(() => window.albumApi.getAlbum());
    assert.equal(recognized.photos.find((p) => p.id === first.id).ocrStatus, 'done');
    assert.deepEqual(recognized.photos.find((p) => p.id === first.id).bibNumbers, ['00127']);

    await desktop.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, destination);
    const exported = await page.evaluate((photoId) => window.albumApi.exportPhotos({ photoIds: [photoId], groupBy: 'none' }), first.id);
    assert.equal(exported.copied, 1); assert.deepEqual(exported.errors, []);
    assert.ok(exported.directory.startsWith(destination));
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(exported.directory, '001-number.png'))).digest('hex'), originalChecksum);
    assert.equal(createHash('sha256').update(await fs.readFile(first.path)).digest('hex'), originalChecksum);
    assert.ok((await fs.readdir(exported.directory)).some((file) => file.endsWith('.csv')));
    await fs.mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/desktop-real-import.png') });
    await desktop.close(); desktop = undefined;

    desktop = await launch(); page = await desktop.firstWindow();
    await expect(page.locator('.photo-card')).toHaveCount(4);
    const restored = await page.evaluate(() => window.albumApi.getAlbum());
    const saved = restored.photos.find((p) => p.id === first.id);
    assert.equal(saved.decision, 'keep'); assert.deepEqual(saved.athleteTags, ['陈一']); assert.deepEqual(saved.bibNumbers, ['00127']);
    assert.deepEqual(errors, []);
    console.log('PASS: real Electron renderer/preload/IPC, empty state, import, cache image protocol, similarity, keyboard selection, tags, local OCR, safe export, and restart persistence.');
  } finally {
    if (desktop) await desktop.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
