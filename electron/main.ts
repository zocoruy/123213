import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LibraryService } from './library';
import { recognizeBibs } from './ocr';
import type { AnalysisSettings, ExportOptions, PhotoPatch, Progress } from '../shared/types';

protocol.registerSchemesAsPrivileged([
  { scheme: 'sprintselect', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let window: BrowserWindow | null = null;
let library: LibraryService;
let operation: AbortController | null = null;

function sendProgress(progress: Progress | null) {
  if (window && !window.isDestroyed()) window.webContents.send('album:progress', progress);
}

async function exclusive<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (operation) throw new Error('请等待当前任务结束，或先取消当前任务。');
  operation = new AbortController();
  try { return await fn(operation.signal); }
  finally { operation = null; sendProgress(null); }
}

function validateIds(ids: unknown): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.length > 100_000 || ids.some((id) => typeof id !== 'string' || id.length > 200)) {
    throw new Error('无效的照片选择。');
  }
}

function registerIpc() {
  const handle = (name: string, fn: (...args: any[]) => unknown) => {
    ipcMain.handle(name, (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('不允许的窗口请求。');
      }
      return fn(...args);
    });
  };
  handle('album:get', () => library.getAlbum());
  handle('album:import', () => exclusive(async (signal) => {
    const result = await dialog.showOpenDialog(window!, {
      title: '选择赛事照片文件夹', properties: ['openDirectory'],
      message: '递归读取文件夹中的照片，不移动或修改原片。',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return library.importFolder(result.filePaths[0], signal);
  }));
  handle('album:update', (ids: string[], patch: PhotoPatch) => exclusive(async () => {
    validateIds(ids);
    return library.updatePhotos(ids, patch);
  }));
  handle('album:analyze', (settings: AnalysisSettings) => exclusive(async () => {
    if (!settings || !Number.isFinite(settings.blurThreshold) || settings.blurThreshold < 0 || settings.blurThreshold > 10000
      || !Number.isFinite(settings.similarityDistance) || settings.similarityDistance < 0 || settings.similarityDistance > 20) {
      throw new Error('分析参数超出范围。');
    }
    return library.analyze(settings);
  }));
  handle('album:ocr', (ids?: string[]) => exclusive(async (signal) => {
    const album = await library.getAlbum();
    if (!album) throw new Error('请先导入照片。');
    if (ids !== undefined) validateIds(ids);
    const selected = ids ? new Set(ids) : null;
    const photos = album.photos.filter((p) => !selected || selected.has(p.id));
    const byId = new Map(album.photos.map((photo) => [photo.id, photo]));
    let completed = 0;
    await recognizeBibs(photos, {
      signal, onProgress: sendProgress,
      onResult: async (id, numbers, error) => {
        const photo = byId.get(id);
        if (!photo) return;
        photo.bibNumbers = [...new Set([...photo.bibNumbers, ...numbers])];
        photo.ocrStatus = error ? 'error' : 'done';
        photo.ocrError = error;
        // Persist during long batches as well as on completion/cancellation.
        if (++completed % 10 === 0) await library.saveAlbum(album);
      },
    });
    return library.saveAlbum(album);
  }));
  handle('album:cancel', () => { operation?.abort(); });
  handle('album:export', (options: ExportOptions) => exclusive(async (signal) => {
    if (!options) throw new Error('缺少导出选项。');
    validateIds(options.photoIds);
    if (!['none', 'athlete', 'time'].includes(options.groupBy)) throw new Error('无效的导出分组。');
    if (options.photoIds.length === 0) throw new Error('请先选择需要导出的照片。');
    const result = await dialog.showOpenDialog(window!, {
      title: '选择导出位置', properties: ['openDirectory', 'createDirectory'],
      message: '在所选目录下新建导出文件夹并复制照片，保留原片。',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const exportFolder = path.join(result.filePaths[0], `SprintSelect-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    return library.exportPhotos(exportFolder, options, signal);
  }));
  handle('album:show', async (id: string) => {
    if (typeof id !== 'string') throw new Error('无效的照片。');
    const album = await library.getAlbum();
    const photo = album?.photos.find((p) => p.id === id);
    if (photo) shell.showItemInFolder(photo.path);
  });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1540, height: 980, minWidth: 1080, minHeight: 700,
    backgroundColor: '#141615', title: 'SprintSelect · 赛事选片', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => { event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (process.env.VITE_DEV_SERVER_URL && !app.isPackaged) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error('开发服务必须在本机运行。');
    await window.loadURL(url.toString());
  } else {
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: sprintselect:; connect-src 'self'; object-src 'none'; base-uri 'self'",
      ] },
    }));
    await window.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
  window.on('closed', () => { window = null; operation?.abort(); });
}

const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    library = new LibraryService(path.join(app.getPath('userData'), 'library'), sendProgress);
    protocol.handle('sprintselect', async (request) => {
      try {
        const url = new URL(request.url);
        const parts = url.pathname.split('/').filter(Boolean);
        if (url.hostname !== 'image' || parts.length !== 2 || !['thumbnail', 'preview'].includes(parts[0])) {
          return new Response('Not found', { status: 404 });
        }
        const file = library.getImagePath(decodeURIComponent(parts[1]), parts[0] as 'thumbnail' | 'preview');
        if (!file) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
      } catch { return new Response('Image unavailable', { status: 404 }); }
    });
    registerIpc();
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  }).catch((error) => {
    dialog.showErrorBox('SprintSelect 启动失败', String(error));
    app.quit();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { operation?.abort(); });
}
